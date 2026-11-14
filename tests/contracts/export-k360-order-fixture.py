"""Export real adapter DTOs using its unit-test harness (simulated DB/native POS).
Usage: python3 tests/contracts/export-k360-order-fixture.py /path/to/konektag_360
The output verifies cross-language serialization; this is NOT production recette.
"""
import importlib.util
import json
import sys
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

source = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(source))
spec = importlib.util.spec_from_file_location('adapter_harness', source / 'tests/test_marketplace_order_adapter.py')
harness = importlib.util.module_from_spec(spec)
spec.loader.exec_module(harness)
t = harness.TestAdapter()
t.setUp()
try:
    reservation = harness.Row(name='RSV-1', pos_profile='POS', phone='+242069123456',
        status='Confirmed', reservation_date='2026-11-15', reservation_time='19:00', guests=2)
    t.f.get_all.return_value = [reservation]
    def get_doc(doctype, *args, **kwargs):
        return reservation if doctype == 'POS Table Reservation' else t.order
    t.f.get_doc.side_effect = get_doc
    with patch.object(t.api, '_resolve', return_value=t.est), patch.object(t.api, '_cart', return_value={'lines': t.args['lines']}):
        options = t.api.options('restaurant', 'POS')
        lookup = t.api.lookup('restaurant', 'POS', reference='RSV-1')
        pickup = t.api.checkout(**t.args)
        assert t.order.k360_customer_email == ''
        args = {**t.args, 'order_mode': 'reservation', 'reservation_reference': 'RSV-1',
                'customer': {**t.args['customer'], 'email': '  CLIENT@Example.test  '}}
        associated = t.api.checkout(**args)
        assert t.order.k360_customer_email == 'client@example.test'
        assert 'client@example.test' not in json.dumps(associated)
        calls_before = t.restaurant.open_order.call_count
        try:
            t.api.checkout(**{**t.args, 'customer': {'email': 'invalid'}})
            raise AssertionError('Invalid email unexpectedly accepted')
        except harness.BusinessError as error:
            assert 'INVALID_ORDER' in str(error)
        assert t.restaurant.open_order.call_count == calls_before
        t.order.k360_acceptance_status='Accepted'
        t.order.k360_share_expires=datetime(2026,11,20)
        t.f.db.get_value.return_value='ORDER'
        t.f.get_all.return_value=[]
        client=t.api.client_order('restaurant','POS','a'*43)
        t.f.get_all.side_effect=[[t.order],[]]
        order_lookup=t.api.order_lookup('restaurant','POS',reference='ORDER')
        t.f.get_all.side_effect=None
        tracked=t.api.tracking_order('restaurant','POS','ORDER')
        assert 'client@example.test' not in json.dumps(client)
    output={'provenance': 'Real K360 adapter functions, Frappe/native POS mocked by its unit-test harness; not a deployed integration test.', 'optionalEmailVerified': True, 'options': options, 'lookup': lookup, 'pickup': pickup, 'reservation': associated, 'client': client, 'orderLookup': order_lookup, 'tracking': tracked}
    print(json.dumps(output, indent=2))
finally:
    t.tearDown()
