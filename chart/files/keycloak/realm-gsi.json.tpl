{{- $scheme := include "chat-gsi.scheme" . -}}
{{- $chat := printf "%s://%s" $scheme .Values.hosts.chat -}}
{{- $grafana := printf "%s://%s" $scheme .Values.hosts.grafana -}}
{
  "realm": {{ .Values.oidc.realm | quote }},
  "enabled": true,
  "displayName": "GSI",
  "registrationAllowed": false,
  "loginWithEmailAllowed": true,
  "roles": {
    "realm": [
      { "name": "llmbot-user", "description": "May use the GSI assistant" },
      {
        "name": "llmbot-privileged",
        "description": "Department manager: may set knowledge-base access for members of the groups they manage",
        "composite": true,
        "composites": { "realm": ["llmbot-user"] }
      },
      {
        "name": "llmbot-admin",
        "description": "May manage groups, knowledge-base ceilings, sources and crawls",
        "composite": true,
        "composites": { "realm": ["llmbot-user"] }
      }
    ]
  },
  "defaultRoles": ["llmbot-user"],
  "clients": [
    {
      "clientId": {{ .Values.oidc.clientId | quote }},
      "name": "GSI Assistant",
      "enabled": true,
      "protocol": "openid-connect",
      "publicClient": false,
      "standardFlowEnabled": true,
      "directAccessGrantsEnabled": false,
      "serviceAccountsEnabled": false,
      "secret": {{ required "secrets.oidcClientSecret is required" .Values.secrets.oidcClientSecret | quote }},
      "redirectUris": [ "{{ $chat }}/auth/callback" ],
      "webOrigins": [ "{{ $chat }}" ],
      "attributes": {
        "pkce.code.challenge.method": "S256",
        "post.logout.redirect.uris": "{{ $chat }}/*"
      }
    },
    {
      "clientId": "{{ .Values.oidc.clientId }}-admin",
      "name": "GSI Assistant - directory lookups",
      "description": "Read-only service account for the admin user picker: view-users/query-users only. Separate from the login client so a compromised session cannot reach the Admin API.",
      "enabled": true,
      "protocol": "openid-connect",
      "publicClient": false,
      "standardFlowEnabled": false,
      "directAccessGrantsEnabled": false,
      "serviceAccountsEnabled": true,
      "secret": {{ required "secrets.keycloakAdminClientSecret is required" .Values.secrets.keycloakAdminClientSecret | quote }}
    },
    {
      "clientId": "grafana",
      "name": "Grafana - observability dashboards",
      "description": "Login client for Grafana, llmbot-admin only. Grafana maps that realm role to its own Admin role and refuses anyone it cannot map (role_attribute_strict), so access is a Keycloak role change.",
      "enabled": true,
      "protocol": "openid-connect",
      "publicClient": false,
      "standardFlowEnabled": true,
      "directAccessGrantsEnabled": false,
      "serviceAccountsEnabled": false,
      "secret": {{ required "secrets.grafanaOidcClientSecret is required" .Values.secrets.grafanaOidcClientSecret | quote }},
      "redirectUris": [
        "{{ $grafana }}/login/generic_oauth",
        "http://localhost:3001/login/generic_oauth"
      ],
      "webOrigins": [ "{{ $grafana }}", "http://localhost:3001" ],
      "attributes": {
        "pkce.code.challenge.method": "S256",
        "post.logout.redirect.uris": "{{ $grafana }}/*##http://localhost:3001/*"
      },
      "protocolMappers": [
        {
          "name": "realm roles as a top-level claim",
          "protocol": "openid-connect",
          "protocolMapper": "oidc-usermodel-realm-role-mapper",
          "consentRequired": false,
          "config": {
            "claim.name": "roles",
            "jsonType.label": "String",
            "multivalued": "true",
            "id.token.claim": "true",
            "access.token.claim": "true",
            "userinfo.token.claim": "true"
          }
        },
        {
          "name": "groups",
          "protocol": "openid-connect",
          "protocolMapper": "oidc-group-membership-mapper",
          "consentRequired": false,
          "config": {
            "claim.name": "groups",
            "full.path": "false",
            "id.token.claim": "true",
            "access.token.claim": "true",
            "userinfo.token.claim": "true"
          }
        }
      ]
    }
  ],
  "users": [
    {
      "username": "service-account-{{ .Values.oidc.clientId }}-admin",
      "enabled": true,
      "serviceAccountClientId": "{{ .Values.oidc.clientId }}-admin",
      "clientRoles": {
        "realm-management": ["view-users", "query-users", "query-groups"]
      }
    }
    {{- if .Values.keycloak.seedUsers }}
    ,
    {
      "username": "testuser", "enabled": true, "email": "testuser@gsi.de",
      "firstName": "Test", "lastName": "User", "emailVerified": true,
      "credentials": [ { "type": "password", "value": "testuser", "temporary": false } ],
      "realmRoles": ["llmbot-user", "llmbot-admin"]
    },
    {
      "username": "manager", "enabled": true, "email": "manager@gsi.de",
      "firstName": "Marta", "lastName": "Manager", "emailVerified": true,
      "credentials": [ { "type": "password", "value": "manager", "temporary": false } ],
      "realmRoles": ["llmbot-user", "llmbot-privileged"]
    },
    {
      "username": "normaluser", "enabled": true, "email": "normaluser@gsi.de",
      "firstName": "Norbert", "lastName": "Nutzer", "emailVerified": true,
      "credentials": [ { "type": "password", "value": "normaluser", "temporary": false } ],
      "realmRoles": ["llmbot-user"]
    }
    {{- end }}
  ]
}
