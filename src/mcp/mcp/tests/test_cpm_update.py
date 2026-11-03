import asyncio
import pytest
from cpm_client import CPMClient


def test_update_requires_explicit_confirmation():
    client = CPMClient.__new__(CPMClient)
    with pytest.raises(PermissionError, match="CONFIRMATION"):
        asyncio.run(client.update("facebook","FR","Konektag France","7.41","8.40"))


def test_update_uses_shared_backend_and_exact_values():
    client = CPMClient.__new__(CPMClient)
    calls=[]
    class FakeApi:
        async def request(self,method,path,*,payload=None,params=None):
            calls.append((method,path,payload))
            return {"updated":True,"verified":True,"cpm":"8.40"}
    client.api=FakeApi()
    response=asyncio.run(client.update("facebook","FR","Konektag France","7.41","8.40",True))
    assert response["verified"] is True
    assert calls==[("POST","/api/admin/boost-pricing/update",{
        "channel":"facebook","target_country":"FR","billing_company":"Konektag France",
        "expected_cpm":"7.41","new_cpm":"8.40","confirm":True})]


def test_update_rejects_invalid_country():
    client=CPMClient.__new__(CPMClient)
    with pytest.raises(ValueError,match="INVALID_TARGET_COUNTRY"):
        asyncio.run(client.update("facebook","../","Konektag France","7.41","8.40",True))
