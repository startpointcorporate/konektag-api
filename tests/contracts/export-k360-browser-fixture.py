"""Export actual creator-management DTOs with K360's mocked DB/native harness.
Usage: /path/to/test/venv/python script.py /path/to/konektag_360
This checks cross-language serialization, not deployed DB concurrency.
"""
import importlib.util
import json
import sys
from pathlib import Path
from unittest.mock import patch
source=Path(sys.argv[1]).resolve()
sys.path[:0]=[str(source),str(source/'tests')]
spec=importlib.util.spec_from_file_location('browser_harness',source/'tests/test_marketplace_order_browser.py')
harness=importlib.util.module_from_spec(spec)
spec.loader.exec_module(harness)
t=harness.TestBrowser();t.setUp()
try:
    reservation=harness.Row(doctype='POS Table Reservation',name='RSV-1',pos_profile='POS',
        creation='2026-11-14 12:00:00.000001',modified='2026-11-14 12:00:00.123456',
        status='Requested',reservation_date='2026-11-15',reservation_time='19:00',guests=2,
        customer_name='Client Test',phone='+12025550130',note='',k360_owner_hash='c'*64,
        save=t.order.save,check_permission=t.order.check_permission)
    t.f.get_all.return_value=[]
    with patch.object(t.api,'_resolve',return_value=t.est),patch.object(t.api,'_cart',return_value={'lines':t.args['lines']}),patch.dict(sys.modules,{'konektag_360.marketplace_orders.browser':t.browser}):
        created=t.api.checkout(**{**t.args,'owner_hash':'c'*64})
        reserved=t.browser.creation_result(reservation,'c'*64,reference='RSV-1',status='Requested',reused=False)
        def load(pos_profile,kind,owner_hash,reference=None,request_key=None,establishment=None):
            if owner_hash!='c'*64:return None
            if kind=='order' and (reference=='ORDER' or request_key=='a'*64):return t.order
            if kind=='reservation' and reference=='RSV-1':return reservation
            return None
        with patch.object(t.browser,'_load',side_effect=load):
            batch=t.browser.browser_reconcile('restaurant','POS',[
                {'index':1,'type':'order','reference':'ORDER','owner_hash':'c'*64},
                {'index':3,'type':'reservation','reference':'RSV-1','owner_hash':'c'*64}])
            updated=t.browser.browser_update_order(**t.base,currency='XAF',lines=t.args['lines'],note='Updated')
            cancelled=t.browser.browser_cancel_reservation('restaurant','POS','RSV-1','c'*64,
                reservation.modified,'f'*64,'e'*64)
    print(json.dumps({'provenance':'Actual K360 management functions; DB/native mutations simulated by its unit harness, not production evidence.',
        'ownerHash':'c'*64,'orderCreation':created,'reservationCreation':reserved,'batch':batch,'updated':updated,'cancelled':cancelled},indent=2))
finally:t.tearDown()
