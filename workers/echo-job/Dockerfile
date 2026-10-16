# The cloud side of the PC-to-cloud echo: one small step every few minutes that reads the PC's signed message from a private bucket prefix, acknowledges it, and writes its own.
# No network path to the PC exists. Standard library only; the signing key (the ingest secret) arrives at run time from Secret Manager.
# The build folder is assembled by rabbit-web/scripts/powershell/Setup-GcpEcho.ps1, which copies research-agents/echo_link.py and echo_record.py next to this Dockerfile.
FROM python:3.12-slim
WORKDIR /app
COPY echo_link.py echo_record.py ./
RUN python -c "import echo_link, echo_record" && useradd --system --uid 10001 echo
USER echo
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
CMD ["python", "echo_link.py", "--side", "cloud"]
