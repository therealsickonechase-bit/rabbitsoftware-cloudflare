# The rabbit web miner as a Cloud Run job. Standard library only, no secrets inside the image (the ingest secret arrives at run time from Secret Manager).
# The build folder is assembled by rabbit-web/scripts/powershell/Setup-GcpMinerJob.ps1 from research-agents: it copies exactly the files listed below next to this Dockerfile.
#   run_cloud.py  maxwell_adopt.py  maxwell_chain_sync.py  maxwell_links.py  maxwell_research_anchor.py  maxwellblockchain.py  rabbitweb_miner.py
FROM python:3.12-slim
WORKDIR /app
COPY run_cloud.py maxwell_adopt.py maxwell_chain_sync.py maxwell_links.py maxwell_research_anchor.py maxwellblockchain.py rabbitweb_miner.py ./
RUN python -c "import run_cloud" && useradd --system --uid 10001 miner
USER miner
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
CMD ["python", "run_cloud.py"]
