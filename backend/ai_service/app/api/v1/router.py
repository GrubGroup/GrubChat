"""Aggregates all v1 routers under /api/v1."""

from fastapi import APIRouter

from app.api.v1.routes import ai, health, voice

api_router = APIRouter(prefix="/api/v1")
api_router.include_router(health.router)
api_router.include_router(ai.router)
api_router.include_router(voice.router)
