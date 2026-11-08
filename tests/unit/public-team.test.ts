import {describe,expect,it,vi} from 'vitest';
import {MemberNotFound,publicTeam,TeamNotFound} from '../../src/application/services/public-team.ts';

const row={team_member_id:'8f0c381e-79b7-4c58-92b5-278a7f2e6068',public_slug:'amina-8f0c381e',publication_version:'3',delivered_at:'2026-11-08T12:00:00Z',display_order:10,display_name:'Amina Mbemba',snapshot:{first_name:'Amina',last_name:'Mbemba',display_name:'Amina Mbemba',display_order:10,public_email:'amina@example.com',links:[]}};
describe('public team reader',()=>{
 it('isolates list reads by tenant and active source',async()=>{const query=vi.fn().mockResolvedValueOnce({rows:[{active:true}]}).mockResolvedValueOnce({rows:[row]});const value=await publicTeam(query).list('konektag',{limit:24});expect(value.items[0].id).toBe(row.team_member_id);expect(query.mock.calls[1][0]).toContain("m.tenant_id=$1 AND m.status='Published' AND s.status='Active'");expect(query.mock.calls[1][1][0]).toBe('konektag');});
 it('returns TEAM_NOT_FOUND semantics when every source is revoked',async()=>{const query=vi.fn().mockResolvedValue({rows:[{active:false}]});await expect(publicTeam(query).list('konektag',{limit:24})).rejects.toBeInstanceOf(TeamNotFound);});
 it('hides unpublished, absent and revoked-source details alike',async()=>{const query=vi.fn().mockResolvedValueOnce({rows:[{active:true}]}).mockResolvedValueOnce({rows:[]});await expect(publicTeam(query).detail('konektag','amina-8f0c381e')).rejects.toBeInstanceOf(MemberNotFound);expect(query.mock.calls[1][0]).toContain("m.status='Published' AND s.status='Active'");});
 it('maps detail contacts without exposing its source',async()=>{const query=vi.fn().mockResolvedValueOnce({rows:[{active:true}]}).mockResolvedValueOnce({rows:[row]});const value=await publicTeam(query).detail('konektag',row.public_slug);expect(value.member.contacts.email).toBe('amina@example.com');expect(value.member).not.toHaveProperty('source_site');});
});
