# Vault mirror for Cloud Run: GitHub -> private Google Cloud bucket. The token comes from Secret Manager as GITHUB_TOKEN at run time; nothing secret is in the image.
FROM gcr.io/google.com/cloudsdktool/google-cloud-cli:slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/* \
 && useradd --system --create-home --uid 10001 mirror
COPY mirror.sh /app/mirror.sh
USER mirror
WORKDIR /home/mirror
ENV CLOUDSDK_CORE_DISABLE_PROMPTS=1
CMD ["bash", "/app/mirror.sh"]
