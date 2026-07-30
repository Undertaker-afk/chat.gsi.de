{
  "identities": [
    {
      "name": "{{ .Values.oidc.clientId | default "chat-gsi-de" }}",
      "credentials": [
        {
          "accessKey": {{ required "secrets.s3AccessKey is required" .Values.secrets.s3AccessKey | quote }},
          "secretKey": {{ required "secrets.s3SecretKey is required" .Values.secrets.s3SecretKey | quote }}
        }
      ],
      "actions": [
        "Read:{{ .Values.config.S3_BUCKET | default "gsi-uploads" }}",
        "Write:{{ .Values.config.S3_BUCKET | default "gsi-uploads" }}",
        "List:{{ .Values.config.S3_BUCKET | default "gsi-uploads" }}",
        "Tagging:{{ .Values.config.S3_BUCKET | default "gsi-uploads" }}",
        "Admin:{{ .Values.config.S3_BUCKET | default "gsi-uploads" }}"
      ]
    }
  ]
}
