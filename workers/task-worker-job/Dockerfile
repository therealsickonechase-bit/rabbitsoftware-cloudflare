# The RabbitOS task worker as a Cloud Run job: claims one approved task from the app queue, runs it against PUBLIC sources (PubMed, Europe PMC, ClinicalTrials.gov, NCBI RefSeq) and sends back a PROPOSAL
# that the owner approves on the website. No personal data is handled; the ingest secret arrives at run time from Secret Manager. The build folder is assembled by
# rabbit-web/scripts/powershell/Setup-GcpTaskWorker.ps1, which copies exactly the research-agents files listed below next to this Dockerfile:
#   task_worker.py rabbit_sync.py multi_source_research.py extended_research_sources.py research_matcher.py http_util.py brain_research.py crispr_data.py crispr_guide_design.py
FROM python:3.12-slim
WORKDIR /app
RUN pip install --no-cache-dir biopython==1.85 && useradd --system --uid 10001 worker
COPY task_worker.py stage_box.py echo_link.py toolbox.py dna_fingerprint.py dna_binary_codec.py rabbit_sync.py multi_source_research.py extended_research_sources.py research_matcher.py http_util.py brain_research.py crispr_data.py crispr_guide_design.py ./
RUN python -c "import task_worker, stage_box, echo_link, toolbox, rabbit_sync, multi_source_research, extended_research_sources, research_matcher, brain_research, crispr_data"
USER worker
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 RABBIT_URL=https://app.rabbitsoftware.io
CMD ["python", "task_worker.py", "--once"]
