"""
Globe Tracker — FastAPI entry point.

Install and run:
    cd globe-tracker/backend
    python -m venv .venv && source .venv/bin/activate   # Windows: .venv\\Scripts\\activate
    pip install -r requirements.txt
    cp .env.example .env      # then fill in your API keys
    python main.py            # or: uvicorn main:app --reload --port 8000

API docs auto-generated at: http://localhost:8000/docs
"""

import asyncio
import os
from contextlib import asynccontextmanager
from dotenv import load_dotenv

# Load .env before any other import that reads env vars.
load_dotenv()

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from routers import planes, ships, flight_info, ship_info, history, satellites
from services import aisstream_client
import db


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Initialise SQLite history store.
    await db.init()

    # Start aisstream.io WebSocket + periodic ship snapshot.
    tasks = []
    api_key = os.getenv("AISSTREAM_API_KEY", "").strip()
    if api_key:
        tasks.append(asyncio.create_task(aisstream_client.run(api_key)))
        tasks.append(asyncio.create_task(aisstream_client.snapshot_loop()))
    else:
        print("[aisstream] WARNING: AISSTREAM_API_KEY not set — ship data will be empty.")

    yield

    for t in tasks:
        t.cancel()


app = FastAPI(
    title="Globe Tracker API",
    description="Live ADS-B + AIS globe with history replay.",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET"],
    allow_headers=["*"],
)

app.include_router(planes.router,      prefix="/api")
app.include_router(ships.router,       prefix="/api")
app.include_router(flight_info.router, prefix="/api")
app.include_router(ship_info.router,   prefix="/api")
app.include_router(history.router,     prefix="/api")
app.include_router(satellites.router,  prefix="/api")


@app.get("/health")
async def health():
    return {"status": "ok"}


if __name__ == "__main__":
    port = int(os.getenv("PORT", "8000"))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
