import os
from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    APP_NAME: str = "RoadLens AI Forensic Engine"
    DATABASE_URL: str = os.getenv(
        "DATABASE_URL",
        "postgresql+asyncpg://postgres:postgres@localhost:5432/roadlens_forensics"
    )
    SPEED_LIMIT_KMH: float = 50.0
    TIMEZONE: str = "Asia/Kolkata"
    RETENTION_DAYS: int = 30
    OFFICIAL_CHALLAN_URL: str = "https://echallan.parivahan.gov.in/index/accused-challan"
    CORS_ORIGINS: list[str] = ["*"]

    class Config:
        env_file = ".env"

settings = Settings()
