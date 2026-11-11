"""Real native ERPNext acceptance, executed inside bench --site SITE console.
Opt-in: exec with KON73_ALLOW_NATIVE_ROLLBACK=True in that isolated process.
No fake controllers, responses or Frappe environment. Guards reject (never fake
success for) commit, notification, background-job or outbound network attempts.
This tests native controllers in one transaction, not the API's HTTP transactions.
"""
import hashlib
import json
import socket
import frappe
import sys
import traceback
from frappe import client as native_client
from frappe.client import submit
from erpnext.selling.doctype.quotation.quotation import make_sales_order
import erpnext.accounts.doctype.payment_request.payment_request as payment_request
import frappe.utils.background_jobs as jobs
import frappe.realtime as realtime

if globals().get('KON73_ALLOW_NATIVE_ROLLBACK') is not True:
    raise RuntimeError('Explicit rollback acceptance opt-in required')
fixtures = {
    'europe.erp.konektag.eu': ('api-europe@konektag.eu', 'cb19d1b0-1787-491e-abbf-d9a385c6ae19', 12, 'EUR'),
    'congo.erp.konektag.eu': ('api-congo@konektag.eu', '805b13b8-3a20-407f-aef4-9a4b52416079', 8567, 'XAF'),
    'liban.erp.konektag.eu': ('api-lebanon@konektag.eu', '8e9ccf2e-d8e9-4abc-ae06-275aecddfb41', 12.21, 'USD'),
}
user, alias, expected_total, currency = fixtures[frappe.local.site]
doctypes = ['Customer', 'Lead', 'Quotation', 'Sales Order', 'Payment Request', 'Sales Invoice',
            'Payment Entry', 'GL Entry', 'Email Queue', 'Communication', 'Notification Log',
            'Version', 'ToDo', 'Integration Request']

def counts():
    return {d: frappe.db.count(d) for d in doctypes}

def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, default=str).encode()).hexdigest()

# Fail closed before touching transactional documents. No production setting changes.
assert not frappe.get_all('Payment Gateway Account', limit=1)
assert not frappe.get_all('Webhook', filters={'enabled': 1}, limit=1)
assert not frappe.get_all('Workflow', filters={'is_active': 1}, limit=1)
assert not frappe.get_all('Assignment Rule', filters={'disabled': 0}, limit=1)
assert not frappe.get_all('Server Script', filters={'disabled': 0}, limit=1)
source = frappe.get_doc('Quotation', 'SAL-QTN-2026-00003')
assert source.quotation_to == 'Lead' and not source.get('crm_deal') and not source.get('k360_reservation')
customers = frappe.get_all('Customer', filters={'alias': alias}, fields=['name', 'lead_name', 'alias'])
assert len(customers) == 1 and customers[0].lead_name == source.party_name
customer = customers[0]
assert source.currency == currency and source.docstatus == 1
assert all(not frappe.db.get_value('Item', i.item_code, 'is_stock_item') for i in source.items)
source_before = digest(source.as_dict())
frappe.db.rollback()
before = counts()
series_before = digest(frappe.db.sql('select name, current from tabSeries order by name'))
result = {'site': frappe.local.site, 'before': before, 'steps': [], 'blocked_effects': [], 'fixture_delivery_date': False}
created = []

class ForbiddenEffect(RuntimeError):
    pass

def deny(*args, **kwargs):
    result['blocked_effects'].append('commit_or_external_effect')
    raise ForbiddenEffect('KON73 commit/external output forbidden')

# Keep reads/controllers real; no fake success or synthetic ERPNext data.
original_commit = frappe.db.commit
original_connect = socket.socket.connect
original_enqueue = jobs.enqueue
original_frappe_enqueue = frappe.enqueue
original_pr_enqueue = payment_request.enqueue
original_emit = realtime.emit_via_redis
original_sendmail = frappe.sendmail
frappe.db.commit = deny
socket.socket.connect = deny
jobs.enqueue = deny
frappe.enqueue = deny
payment_request.enqueue = deny
realtime.emit_via_redis = deny
frappe.sendmail = deny
try:
    frappe.set_user(user)
    q = frappe.copy_doc(source)
    q.docstatus = 0
    q.remarks = 'KON73 API delivery date rollback acceptance'
    q.insert()
    created.append(('Quotation', q.name))
    assert not q.get('delivery_date') and not any(i.get('delivery_date') for i in q.items)
    print('KON73_RPC=' + json.dumps({'id': 0, 'data': {'customer': customer.name, 'quotation': q.name,
        'alias': alias, 'expected_total': expected_total, 'currency': currency}}, default=str), flush=True)
    for line in sys.stdin:
        request = json.loads(line)
        rid, op, args = request['id'], request['op'], request.get('args', {})
        try:
            if op == 'rollback':
                print('KON73_RPC=' + json.dumps({'id': rid, 'data': True}), flush=True)
                break
            if op in ('get', 'list', 'insert'):
                assert args['doctype'] in ['Customer', 'Quotation', 'Sales Order', 'Payment Request', 'Mode of Payment', 'Payment Gateway Account']
            if op == 'get':
                data = native_client.get(args['doctype'], args['name'])
            elif op == 'list':
                data = native_client.get_list(args['doctype'], fields=args['fields'], filters=args['filters'], limit_page_length=args.get('limit', 100))
            elif op == 'insert':
                assert args['doctype'] == 'Sales Order'
                doc = args['doc']
                assert doc['customer'] == customer.name
                assert all(i.get('prevdoc_docname') == q.name for i in doc['items'])
                data = native_client.insert(dict(doc, doctype='Sales Order'))
                created.append(('Sales Order', data['name']))
            elif op == 'call':
                method, params = args['method'], args['params']
                if method == 'frappe.client.submit':
                    d = params['doc']
                    assert (d['doctype'], d['name']) in created
                    data = native_client.submit(d)
                elif method == 'erpnext.selling.doctype.quotation.quotation.make_sales_order':
                    assert params['source_name'] == q.name
                    data = make_sales_order(**params)
                elif method == 'erpnext.accounts.doctype.payment_request.payment_request.make_payment_request':
                    assert params['dt'] == 'Sales Order' and ('Sales Order', params['dn']) in created
                    assert params['mute_email'] == 1 and params['submit_doc'] == 1
                    assert not frappe.get_all('Payment Gateway Account', limit=1)
                    data = payment_request.make_payment_request(**params)
                    created.append(('Payment Request', data.name))
                else:
                    raise AssertionError('Forbidden native method')
            elif op == 'inspect':
                docs = {d: frappe.get_doc(d, n) for d, n in created}
                so, pr = docs['Sales Order'], docs['Payment Request']
                assert so.docstatus == 1 and pr.docstatus == 1
                assert so.customer == pr.party == customer.name
                assert so.delivery_date == so.transaction_date
                assert all(i.delivery_date == so.delivery_date for i in so.items)
                assert any(i.prevdoc_docname == q.name for i in so.items)
                assert pr.reference_doctype == 'Sales Order' and pr.reference_name == so.name
                assert float(pr.grand_total) == expected_total and pr.currency == currency
                assert not pr.payment_gateway and not pr.payment_url and not pr.make_sales_invoice
                assert frappe.db.get_value('Customer', customer.name, 'alias') == alias
                data = {'counts': counts(), 'customer_preserved': True, 'references_preserved': True,
                    'quotation_status': frappe.db.get_value('Quotation', q.name, 'docstatus'),
                    'sales_order_status': so.docstatus, 'payment_request_status': pr.docstatus,
                    'transaction_date': str(so.transaction_date), 'delivery_date': str(so.delivery_date),
                    'row_delivery_dates': [str(i.delivery_date) for i in so.items],
                    'quotation_total': float(q.rounded_total or q.grand_total),
                    'sales_order_total': float(so.rounded_total or so.grand_total),
                    'payment_request_total': float(pr.grand_total), 'currency': pr.currency,
                    'refs_hashes': {d: digest(n) for d, n in created}}
                result['native'] = data
            else:
                raise AssertionError('Forbidden RPC operation')
            if callable(getattr(data, 'as_dict', None)):
                data = data.as_dict()
            print('KON73_RPC=' + json.dumps({'id': rid, 'data': data}, default=str), flush=True)
        except Exception as exc:
            traceback.print_exc(file=sys.stderr)
            print('KON73_RPC=' + json.dumps({'id': rid, 'error': {'type': type(exc).__name__, 'message': str(exc)[:400]}}, default=str), flush=True)
except Exception as exc:
    result['error'] = {'type': type(exc).__name__, 'message': str(exc)[:400]}
finally:
    frappe.db.rollback()
    frappe.db.commit = original_commit
    socket.socket.connect = original_connect
    jobs.enqueue = original_enqueue
    frappe.enqueue = original_frappe_enqueue
    payment_request.enqueue = original_pr_enqueue
    realtime.emit_via_redis = original_emit
    frappe.sendmail = original_sendmail
    frappe.set_user('Administrator')
    result['after'] = counts()
    result['counts_identical'] = result['after'] == before
    result['created_documents_absent'] = all(not frappe.db.exists(d, n) for d, n in created)
    result['source_unchanged'] = digest(frappe.get_doc('Quotation', source.name).as_dict()) == source_before
    result['series_unchanged'] = digest(frappe.db.sql('select name, current from tabSeries order by name')) == series_before
    frappe.db.rollback()
    print('KON73_BRIDGE_FINAL=' + json.dumps(result, default=str))
