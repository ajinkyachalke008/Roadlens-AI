from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy.orm import declarative_base
from forensics.config import settings

Base = declarative_base()

# Safe engine creation (with fallback / disabled query mode if DB isn't running)
try:
    engine = create_async_engine(settings.DATABASE_URL, echo=False, pool_pre_ping=True)
    AsyncSessionLocal = async_sessionmaker(
        bind=engine,
        class_=AsyncSession,
        expire_on_commit=False
    )
except Exception as e:
    engine = None
    AsyncSessionLocal = None

async def get_db():
    if AsyncSessionLocal is None:
        yield None
        return
    async with AsyncSessionLocal() as session:
        try:
            yield session
        finally:
            await session.close()
