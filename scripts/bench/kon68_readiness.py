"""Replay KON-68's scoped native ERPNext configuration corrections.

Execute inside an initialized `bench --site SITE console` session:
    exec(compile(open('/tmp/kon68_readiness.py').read(), '/tmp/kon68_readiness.py', 'exec'), globals())
    run(apply=True)
No auth tokens, tax rates, transactions or application hooks are configured.
"""
SITES = {
    'europe.erp.konektag.eu': ('konektag europe', 'api-europe@konektag.eu'),
    'congo.erp.konektag.eu': ('konektag congo', 'api-congo@konektag.eu'),
    'liban.erp.konektag.eu': ('konektag lebanon', 'api-lebanon@konektag.eu'),
}
ROLE = 'Konektag Points K Price Reader'
PERMISSIONS = dict(read=1, select=1, write=0, create=0, delete=0, submit=0,
                   cancel=0, amend=0, report=0, export=0, print=0, share=0, email=0)


def run(apply=False):
    import frappe
    from frappe.permissions import add_permission, update_permission_property

    site = frappe.local.site
    if site not in SITES:
        raise ValueError('Only the three Konektag business sites are authorized')
    company, username = SITES[site]
    if not frappe.db.exists('Company', company) or not frappe.db.exists('User', username):
        raise ValueError('Expected existing company/service user is absent')
    current_user = frappe.session.user
    changed = []
    try:
        members = set(frappe.get_all('Has Role', filters={'role': ROLE, 'parenttype': 'User'}, pluck='parent'))
        if members - {username}:
            raise ValueError('Price Reader role has other users; review scope before changes')
        if not frappe.db.exists('Role', ROLE):
            frappe.get_doc(dict(doctype='Role', role_name=ROLE, desk_access=0)).insert()
            changed.append('create Role')
        rows = frappe.get_all('Custom DocPerm', filters={'parent': 'Item Price', 'role': ROLE, 'permlevel': 0},
                              fields=['name', *PERMISSIONS])
        if len(rows) > 1:
            raise ValueError('Ambiguous Item Price custom permissions')
        if not rows:
            # Native API preserves the other existing standard/custom permissions.
            add_permission('Item Price', ROLE, permlevel=0)
            changed.append('add Item Price permission')
            rows = frappe.get_all('Custom DocPerm', filters={'parent': 'Item Price', 'role': ROLE, 'permlevel': 0},
                                  fields=['name', *PERMISSIONS])
        for field, value in PERMISSIONS.items():
            if int(rows[0].get(field) or 0) != value:
                update_permission_property('Item Price', ROLE, 0, field, value)
                changed.append('Item Price.' + field)
        user = frappe.get_doc('User', username)
        if not user.enabled:
            raise ValueError('Service account is disabled')
        if ROLE not in [r.role for r in user.roles]:
            user.add_roles(ROLE)
            changed.append('assign Price Reader role')
        if site == 'congo.erp.konektag.eu':
            settings = frappe.get_doc('Accounts Settings')
            expected = {'add_taxes_from_taxes_and_charges_template': 1, 'add_taxes_from_item_tax_template': 0}
            if any(settings.get(k) != v for k, v in expected.items()):
                settings.update(expected)
                settings.save()  # Native validation enforces mutually exclusive modes.
                changed.append('Congo native compound-tax loading mode')
        frappe.set_user(username)
        if (not frappe.has_permission('Item Price', 'read')
                or frappe.has_permission('Item Price', 'write')
                or frappe.has_permission('Item Price', 'create')):
            raise ValueError('Effective service permissions are not read-only')
        frappe.set_user(current_user)
        if apply:
            frappe.db.commit()
        else:
            frappe.db.rollback()
        if changed:
            frappe.clear_cache(user=username)
            frappe.clear_cache(doctype='Item Price')
            frappe.clear_document_cache('Accounts Settings', 'Accounts Settings')
        return {'site': site, 'service_user': username, 'changed': changed,
                'item_price_read_only': True, 'mode': 'apply' if apply else 'dry-run rolled back'}
    except Exception:
        frappe.db.rollback()
        frappe.clear_cache(user=username)
        frappe.clear_cache(doctype='Item Price')
        raise
    finally:
        frappe.set_user(current_user)
