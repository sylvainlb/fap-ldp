INSERT INTO app.users (id, webid, name, role) VALUES (1,'http://localhost:18880/users/1','Alice','gestionnaire'),(2,'http://localhost:18880/users/2','Bob','technicien');
INSERT INTO app.buildings (id,name,address) VALUES (1,'Bat A','1 rue de test'),(2,'Bat B','2 rue de test');
INSERT INTO app.tickets (id,title,building_id,created_by) VALUES (37,'T37',1,1),(370,'T370',1,1);
SELECT setval('app.tickets_id_seq',1000);
INSERT INTO auth.acl (resource_uri,subject,modes) VALUES
 ('http://localhost:18880/tickets/','role:gestionnaire','{read,write,control}'),
 ('http://localhost:18880/tickets/37','role:technicien','{read}'),
 ('http://localhost:18880/buildings/','role:gestionnaire','{read,write,control}'),
 ('http://localhost:18880/gold/','role:gestionnaire','{read}');
INSERT INTO dsp.contracts (asset_uri,assignee_did,policy_jsonld,state,agreement_id,expires_at) VALUES
 ('http://localhost:18880/buildings/','did:web:partner.example',
  '{"permission":[{"constraint":{"leftOperand":"facis:resourceId","isAnyOf":["1"]}}]}','active','agr-1', now()+interval '1 day');
