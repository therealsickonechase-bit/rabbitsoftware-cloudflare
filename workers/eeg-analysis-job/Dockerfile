# Private EEG analysis for Cloud Run (a job, no URL): reads the PhysioNet EEG Motor Movement/Imagery recordings that the nightly backup keeps in the private backups bucket, computes band-power summaries,
# and writes them back to the same private bucket under analysis/eeg/. It never lists the bucket, has no public endpoint and is not in the Agent Registry.
FROM python:3.12-slim
WORKDIR /app
RUN pip install --no-cache-dir numpy==2.2.6 scipy==1.15.3 && useradd --system --uid 10001 eeg
COPY eeg_analysis.py ./
RUN python -c "import eeg_analysis"
USER eeg
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
CMD ["python", "eeg_analysis.py"]
