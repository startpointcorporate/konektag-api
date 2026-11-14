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
        args = {**t.args, 'order_mode': 'reservation', 'reservation_reference': 'RSV-1'}
        associated = t.api.checkout(**args)
        t.order.k360_acceptance_status='Accepted'
        t.order.k360_share_expires=datetime(2026,11,20)
        t.f.db.get_value.return_value='ORDER'
        client=t.api.client_order('restaurant','POS','a'*43)
    output={'provenance': 'Real K360 adapter functions, Frappe/native POS mocked by its unit-test harness; not a deployed integration test.', 'options': options, 'lookup': lookup, 'pickup': pickup, 'reservation': associated, 'client': client}
    print(json.dumps(output, indent=2))
finally:
    t.tearDown()
