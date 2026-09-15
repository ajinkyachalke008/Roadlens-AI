from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from forensics.config import settings
from forensics.database import engine, Base
from forensics.routes import router

@asynccontextmanager
async def lifespan(app: FastAPI):
    if engine is not None:
        try:
            async with engine.begin() as conn:
                await conn.run_sync(Base.metadata.create_all)
        except Exception as e:
            print(f"[Forensics] Database initialization warning (PostgreSQL offline): {e}")
    yield

app = FastAPI(
    title=settings.APP_NAME,
    version="2.0.0",
    description="Enterprise Natural Language Traffic Forensic Search Engine",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("forensics.main:app", host="0.0.0.0", port=8000, reload=True)
