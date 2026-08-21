{{- define "astra.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "astra.fullname" -}}
{{- printf "%s-%s" .Release.Name (include "astra.name" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "astra.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}{{ default (include "astra.fullname" .) .Values.serviceAccount.name }}{{ else }}{{ default "default" .Values.serviceAccount.name }}{{ end }}
{{- end }}
