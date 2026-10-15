# Bitcoin anchoring (OpenTimestamps) as a Cloud Run job. No keys and no secrets: it reads public chain heads and writes proofs under anchors/ in the public ledger bucket.
#   gcloud builds submit workers/anchor-job --tag us-west2-docker.pkg.dev/rabbitsoftware-io/rabbit-software/anchor-job:latest
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
 && useradd --system --uid 10001 anchor
COPY src/anchor.py ./
RUN python -c "import anchor"
USER anchor
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
CMD ["python", "anchor.py"]
