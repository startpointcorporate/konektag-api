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
from frappe.utils import nowdate
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
result = {'site': frappe.local.site, 'before': before, 'steps': [], 'blocked_effects': [], 'fixture_delivery_date': bool(globals().get('KON73_NATIVE_DELIVERY_DATE'))}
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
    for d in ['Quotation', 'Sales Order', 'Payment Request']:
        for p in ['read', 'create', 'write', 'submit']:
            assert frappe.has_permission(d, p), (d, p)
    q = frappe.copy_doc(source)
    q.docstatus = 0
    q.remarks = 'KON73 transaction rollback acceptance only'
    q.insert()
    created.append(('Quotation', q.name))
    q = frappe.get_doc(submit(q.as_dict()))
    assert q.docstatus == 1
    result['steps'].append('quotation_submitted')
    so = make_sales_order(q.name)
    assert so.customer == customer.name
    if globals().get('KON73_NATIVE_DELIVERY_DATE'):
        # Explicit native fixture precondition. The API currently does not supply this.
        so.delivery_date = nowdate()
        for row in so.items:
            row.delivery_date = nowdate()
    so.insert()
    created.append(('Sales Order', so.name))
    so = frappe.get_doc(submit(so.as_dict()))
    assert so.docstatus == 1 and so.customer == customer.name
    assert any(i.prevdoc_docname == q.name for i in so.items)
    result['steps'].append('sales_order_submitted')
    pr = payment_request.make_payment_request(dt='Sales Order', dn=so.name,
        submit_doc=1, mute_email=1, mode_of_payment='Credit Card')
    created.append(('Payment Request', pr.name))
    assert pr.docstatus == 1 and pr.reference_doctype == 'Sales Order' and pr.reference_name == so.name
    assert pr.party == customer.name and pr.currency == currency
    assert float(pr.grand_total) == expected_total
    assert not pr.payment_gateway and not pr.payment_gateway_account and not pr.payment_url
    assert not pr.make_sales_invoice
    assert frappe.db.get_value('Customer', customer.name, 'alias') == alias
    assert frappe.db.count('Customer') == before['Customer']
    result['steps'].append('payment_request_submitted_without_gateway')
    count_pr = frappe.db.count('Payment Request')
    try:
        payment_request.make_payment_request(dt='Sales Order', dn=so.name,
            submit_doc=1, mute_email=1, mode_of_payment='Credit Card')
    except frappe.ValidationError:
        # Native replay rejects a fully requested amount instead of duplicating it.
        assert frappe.db.count('Payment Request') == count_pr
        assert frappe.db.get_value('Payment Request', pr.name, 'docstatus') == 1
        result['native_duplicate_request_rejected'] = True
    else:
        raise AssertionError('Native replay accepted a duplicate Payment Request')
    result['native'] = {'quotation_status': q.docstatus, 'sales_order_status': so.docstatus,
        'payment_request_status': pr.docstatus, 'customer_preserved': True,
        'quotation_total': float(q.rounded_total or q.grand_total),
        'sales_order_total': float(so.rounded_total or so.grand_total),
        'payment_request_total': float(pr.grand_total), 'currency': currency,
        'refs_hashes': {d: digest(n) for d, n in created}}
    for d in ['Sales Invoice', 'Payment Entry', 'GL Entry', 'Email Queue', 'Communication', 'Notification Log']:
        assert frappe.db.count(d) == before[d], d
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
    print('KON73_NATIVE=' + json.dumps(result, default=str))
