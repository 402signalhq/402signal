FROM python:3.12.14-slim@sha256:e5c9fa26ffb76e11e0f054f30dc2523a2f9693f0c36c0cf1e39b27e152d899fc

WORKDIR /app
COPY scripts/glama_stdio.py ./scripts/glama_stdio.py

ENV PYTHONUNBUFFERED=1
USER 10001:10001

CMD ["python", "scripts/glama_stdio.py"]
