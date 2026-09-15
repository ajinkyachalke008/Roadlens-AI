import uuid
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, desc
from forensics.database import get_db
from forensics.schemas import (
    ForensicSearchRequest,
    ForensicSearchResponse,
    ForensicObservationSchema,
)
from forensics.models import VehicleObservationModel
from forensics.query_parser import parse_server_query
from forensics.search import execute_search

router = APIRouter(prefix="/api/forensics", tags=["forensics"])

@router.get("/health")
async def health_check():
    return {"status": "ok", "service": "roadlens_forensics", "time": datetime.utcnow().isoformat()}

@router.post("/search", response_model=ForensicSearchResponse)
async def search_forensics(req: ForensicSearchRequest, db: AsyncSession = Depends(get_db)):
    query_ast = parse_server_query(req.query)
    return await execute_search(query_ast, db)

@router.post("/ingest")
async def ingest_observation(obs: ForensicObservationSchema, db: AsyncSession = Depends(get_db)):
    if db is None:
        return {"status": "skipped", "reason": "database_not_connected"}

    try:
        ts = datetime.fromisoformat(obs.timestamp.replace("Z", "+00:00"))
    except Exception:
        ts = datetime.utcnow()

    record = VehicleObservationModel(
        id=obs.id or str(uuid.uuid4()),
        vehicle_id=obs.plate.text or f"track-{obs.trackId}" or str(uuid.uuid4()),
        track_id=obs.trackId,
        vehicle_class=obs.vehicleClass,
        color_name=obs.color.name,
        color_hex=obs.color.hex,
        color_confidence=obs.color.confidence,
        plate_number=obs.plate.text,
        plate_state_code=obs.plate.stateCode,
        plate_state_name=obs.plate.stateName,
        rto_location=obs.plate.rtoLocation,
        plate_confidence=obs.plate.confidence,
        speed_kmh=obs.speed.kmh,
        speed_mps=obs.speed.mps,
        is_speeding="true" if obs.speed.isSpeeding else "false",
        speed_confidence=obs.speed.confidence,
        violations=obs.violations,
        camera_id=obs.cameraId,
        camera_name=obs.cameraName,
        latitude=obs.location.latitude,
        longitude=obs.location.longitude,
        landmark=obs.location.landmark,
        timestamp=ts,
        snapshot_data_url=obs.snapshotDataUrl
    )

    db.add(record)
    await db.commit()
    return {"status": "ingested", "id": record.id}

@router.get("/vehicle/{plate_or_id}/route")
async def get_vehicle_route(plate_or_id: str, db: AsyncSession = Depends(get_db)):
    if db is None:
        return []

    stmt = select(VehicleObservationModel).where(
        (VehicleObservationModel.plate_number == plate_or_id) |
        (VehicleObservationModel.vehicle_id == plate_or_id) |
        (VehicleObservationModel.id == plate_or_id)
    ).order_by(VehicleObservationModel.timestamp.asc()).limit(50)

    res = await db.execute(stmt)
    rows = res.scalars().all()
    return rows
