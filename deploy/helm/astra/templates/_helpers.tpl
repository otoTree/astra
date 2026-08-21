{{- define "astra.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "astra.fullname" -}}
{{- printf "%s-%s" .Release.Name (include "astra.name" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "astra.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}{{ default (include "astra.fullname" .) .Values.serviceAccount.name }}{{ else }}{{ default "default" .Values.serviceAccount.name }}{{ end }}
{{- end }}

{{- define "astra.imageReference" -}}
{{- $digest := required "image.tag must be an OCI sha256 digest (sha256:<64 hex>)" .Values.image.tag -}}
{{- if not (regexMatch "^sha256:[0-9a-f]{64}$" $digest) -}}
{{- fail "image.tag must be an OCI sha256 digest (sha256:<64 hex>); mutable tags are not allowed" -}}
{{- end -}}
{{- printf "%s@%s" .Values.image.repository $digest -}}
{{- end }}
