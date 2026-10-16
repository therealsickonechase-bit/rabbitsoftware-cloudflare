# The RabbitOS research explorer as a Cloud Run job (stateless): reads the topic queue from the app, explores up to two queued topics on PUBLIC sources (PubMed, Europe PMC, ClinicalTrials.gov) and sends the
# results back through the signed ingest. It keeps no files. No personal data is handled; the ingest secret arrives at run time from Secret Manager.
# The build folder is assembled by rabbit-web/scripts/powershell/Setup-GcpResearchExplorer.ps1, which copies exactly these research-agents files next to this Dockerfile:
#   cloud_explorer.py task_worker.py rabbit_sync.py multi_source_research.py extended_research_sources.py research_matcher.py http_util.py brain_research.py crispr_data.py crispr_guide_design.py
FROM python:3.12-slim
WORKDIR /app
RUN pip install --no-cache-dir biopython==1.85 && useradd --system --uid 10001 explorer
COPY cloud_explorer.py task_worker.py stage_box.py echo_link.py dna_fingerprint.py dna_binary_codec.py rabbit_sync.py multi_source_research.py extended_research_sources.py research_matcher.py http_util.py brain_research.py crispr_data.py crispr_guide_design.py ./
RUN python -c "import cloud_explorer, task_worker, stage_box, echo_link, rabbit_sync, multi_source_research, extended_research_sources, research_matcher"
USER explorer
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 RABBIT_URL=https://app.rabbitsoftware.io
CMD ["python", "cloud_explorer.py"]
