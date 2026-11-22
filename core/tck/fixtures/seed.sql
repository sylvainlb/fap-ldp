TRUNCATE app.users, app.buildings, app.tickets, app.comments, app.versions, app.tombstones, app.outbox, auth.acl, dsp.contracts, dsp.audit, dsp.capacities CASCADE;
TRUNCATE gold.city_dashboard_summary;
INSERT INTO gold.city_dashboard_summary (id,label,value) VALUES (1,'kpi-1',42),(2,'kpi-2',43);
INSERT INTO app.users (id, webid, name, role) VALUES (1,'http://localhost:18880/users/1','Alice','manager'),(2,'http://localhost:18880/users/2','Bob','technician');
INSERT INTO app.buildings (id,name,address) VALUES (1,'Bat A','1 test street'),(2,'Bat B','2 test street');
INSERT INTO app.tickets (id,title,building_id,created_by) VALUES (37,'T37',1,1),(370,'T370',1,1);
SELECT setval('app.tickets_id_seq',1000);
INSERT INTO auth.acl (resource_uri,subject,modes) VALUES
 ('http://localhost:18880/tickets/','role:manager','{read,write,control}'),
 ('http://localhost:18880/tickets/37','role:technician','{read}'),
 ('http://localhost:18880/buildings/','role:manager','{read,write,control}'),
 ('http://localhost:18880/gold/','role:manager','{read}'),
 ('http://localhost:18880/users/','role:manager','{read}');
INSERT INTO dsp.contracts (asset_uri,assignee_did,policy_jsonld,state,agreement_id,expires_at) VALUES
 ('http://localhost:18880/buildings/','did:web:partner.example',
  '{"permission":[{"constraint":{"leftOperand":"facis:resourceId","isAnyOf":["1"]}}]}','active','agr-1', now()+interval '1 day');
