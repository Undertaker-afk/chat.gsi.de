{{/*
Helpers for the chat-gsi chart.

Design note: workload and Service names are deliberately BARE (db, valkey,
frontend, prometheus, ...) rather than release-prefixed. The internal wiring —
prometheus.yml's scrape target `frontend:3000`, the Grafana datasources
`http://prometheus:9090` / `http://loki:3100`, DATABASE_URL's `db:5432`, the
SeaweedFS callback addresses — is all keyed on these exact names, and the config
files that hold them are shipped verbatim. Prefixing every name would mean
templating all of that too, for no gain: the chart owns its namespace, so there
is nothing to collide with. One install per namespace is the supported model.
*/}}

{{- define "chat-gsi.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Common labels stamped on everything, so `kubectl -l` and Helm both work. */}}
{{- define "chat-gsi.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/part-of: chat-gsi
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
{{- end -}}

{{/* Per-component labels. Call with (dict "ctx" . "component" "frontend"). The
     `app: <component>` label is what every Service selector already matches, so
     it is preserved exactly. */}}
{{- define "chat-gsi.componentLabels" -}}
{{ include "chat-gsi.labels" .ctx }}
app.kubernetes.io/component: {{ .component }}
app: {{ .component }}
{{- end -}}

{{/* http or https, from tls.enabled. Every externally reachable URL derives from
     this so switching to TLS is one value. */}}
{{- define "chat-gsi.scheme" -}}
{{- if .Values.tls.enabled -}}https{{- else -}}http{{- end -}}
{{- end -}}

{{/* Fully-qualified external URLs, built from the configured host + scheme. */}}
{{- define "chat-gsi.url.chat" -}}{{ include "chat-gsi.scheme" . }}://{{ .Values.hosts.chat }}{{- end -}}
{{- define "chat-gsi.url.keycloak" -}}{{ include "chat-gsi.scheme" . }}://{{ .Values.hosts.keycloak }}{{- end -}}
{{- define "chat-gsi.url.s3" -}}{{ include "chat-gsi.scheme" . }}://{{ .Values.hosts.s3 }}{{- end -}}
{{- define "chat-gsi.url.grafana" -}}{{ include "chat-gsi.scheme" . }}://{{ .Values.hosts.grafana }}{{- end -}}

{{/* The OIDC issuer, reused by the app, Grafana and the realm import. Must be
     byte-identical from the browser and from inside every pod. When oidc.issuer
     is set (an EXTERNAL Keycloak), it wins outright; otherwise it is derived
     from the bundled Keycloak's host. */}}
{{- define "chat-gsi.oidcIssuer" -}}
{{- if .Values.oidc.issuer -}}{{ .Values.oidc.issuer }}
{{- else -}}{{ include "chat-gsi.url.keycloak" . }}/realms/{{ .Values.oidc.realm }}{{- end -}}
{{- end -}}

{{/* The Keycloak base URL (no /realms/...), for the app's admin user picker.
     Bundled: the ingress host. External: oidc.adminBaseUrl if given, else the
     issuer with its /realms/<realm> suffix stripped. */}}
{{- define "chat-gsi.keycloakBaseUrl" -}}
{{- if .Values.oidc.adminBaseUrl -}}{{ .Values.oidc.adminBaseUrl }}
{{- else if .Values.keycloak.enabled -}}{{ include "chat-gsi.url.keycloak" . }}
{{- else -}}{{ regexReplaceAll "/realms/[^/]+/?$" (include "chat-gsi.oidcIssuer" .) "" }}{{- end -}}
{{- end -}}

{{/* Keycloak MANAGEMENT URL (/health, metrics collector). Only the bundled
     Keycloak exposes :9000 in-cluster; external installs set oidc.managementUrl
     or leave it empty (the collector degrades to "unreachable"). */}}
{{- define "chat-gsi.keycloakMgmtUrl" -}}
{{- if .Values.keycloak.enabled -}}http://keycloak:9000{{- else -}}{{ .Values.oidc.managementUrl }}{{- end -}}
{{- end -}}

{{/* Resolve one component's image ref: image.<component>.tag falls back to the
     chart appVersion, so a release is one tag unless deliberately pinned. */}}
{{- define "chat-gsi.image" -}}
{{- $ := .ctx -}}
{{- $img := index $.Values.image .component -}}
{{- $tag := $img.tag | default $.Chart.AppVersion -}}
{{- printf "%s:%s" $img.repository $tag -}}
{{- end -}}

{{/* storageClassName line, or nothing when unset so the cluster default wins.
     Call with the ctx as `.`. */}}
{{- define "chat-gsi.storageClass" -}}
{{- if .Values.global.storageClass -}}
storageClassName: {{ .Values.global.storageClass }}
{{- end -}}
{{- end -}}

{{/* The hostAliases block, only when nodeHostAliases.enabled. Indent 6 at the
     call site (pod spec level). This is the lab-only hack that pins .lab names
     to the node IP inside pods; a real cluster with real DNS leaves it off. */}}
{{- define "chat-gsi.hostAliases" -}}
{{- if .Values.nodeHostAliases.enabled }}
hostAliases:
  - ip: {{ .Values.nodeHostAliases.ip | quote }}
    hostnames:
{{- range .Values.nodeHostAliases.hostnames }}
      - {{ . }}
{{- end }}
{{- end -}}
{{- end -}}

{{/* imagePullSecrets block, only when set. */}}
{{- define "chat-gsi.imagePullSecrets" -}}
{{- if .Values.imagePullSecrets }}
imagePullSecrets:
{{- range .Values.imagePullSecrets }}
  - name: {{ .name | default . }}
{{- end }}
{{- end -}}
{{- end -}}
