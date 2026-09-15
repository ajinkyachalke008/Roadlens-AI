import time
from typing import List
from sqlalchemy import select, desc
from sqlalchemy.ext.asyncio import AsyncSession
from forensics.models import VehicleObservationModel
from forensics.schemas import (
    TrafficQueryAST,
    ForensicSearchResponse,
    ForensicObservationSchema,
    ColorAttribute,
    PlateAttribute,
    SpeedAttribute,
    GeoLocation,
)

async def execute_search(query: TrafficQueryAST, db: AsyncSession = None) -> ForensicSearchResponse:
    start_time = time.time()
    results: List[ForensicObservationSchema] = []

    if db is not None:
        try:
            stmt = select(VehicleObservationModel)

            # 1. Color
            if query.colors:
                stmt = stmt.where(VehicleObservationModel.color_name.in_(query.colors))

            # 2. Class
            if query.vehicleClasses:
                stmt = stmt.where(VehicleObservationModel.vehicle_class.in_(query.vehicleClasses))

            # 3. Plate
            if query.plate:
                mode = query.plate.get("mode")
                if mode == "exact" and query.plate.get("text"):
                    stmt = stmt.where(VehicleObservationModel.plate_number.ilike(f"%{query.plate['text']}%"))
                elif mode == "state" and query.plate.get("stateCode"):
                    stmt = stmt.where(VehicleObservationModel.plate_state_code == query.plate["stateCode"])
                elif mode == "has_plate":
                    stmt = stmt.where(VehicleObservationModel.plate_number.isnot(None))
                elif mode == "unscanned":
                    stmt = stmt.where(VehicleObservationModel.plate_number.is_(None))

            # 4. Speed
            if query.speed:
                op = query.speed.get("operator")
                val = query.speed.get("value")
                if op == ">" and val is not None:
                    stmt = stmt.where(VehicleObservationModel.speed_kmh > val)
                elif op == "<" and val is not None:
                    stmt = stmt.where(VehicleObservationModel.speed_kmh < val)
                elif op == "between" and val is not None and query.speed.get("upperValue") is not None:
                    stmt = stmt.where(VehicleObservationModel.speed_kmh.between(val, query.speed["upperValue"]))
                elif op == "speeding":
                    stmt = stmt.where(VehicleObservationModel.is_speeding == "true")

            # Sorting
            if query.sort == "speed_desc":
                stmt = stmt.order_by(desc(VehicleObservationModel.speed_kmh))
            else:
                stmt = stmt.order_by(desc(VehicleObservationModel.timestamp))

            stmt = stmt.limit(query.limit)
            exec_res = await db.execute(stmt)
            rows = exec_res.scalars().all()

            for r in rows:
                results.append(
                    ForensicObservationSchema(
                        id=r.id,
                        reportId=r.id,
                        trackId=r.track_id,
                        vehicleClass=r.vehicle_class,
                        color=ColorAttribute(name=r.color_name, hex=r.color_hex, confidence=r.color_confidence),
                        plate=PlateAttribute(
                            text=r.plate_number,
                            stateCode=r.plate_state_code,
                            stateName=r.plate_state_name,
                            rtoLocation=r.rto_location,
                            confidence=r.plate_confidence
                        ),
                        speed=SpeedAttribute(
                            kmh=r.speed_kmh,
                            mps=r.speed_mps,
                            isSpeeding=(r.is_speeding == "true"),
                            confidence=r.speed_confidence
                        ),
                        violations=r.violations or [],
                        cameraId=r.camera_id,
                        cameraName=r.camera_name,
                        location=GeoLocation(latitude=r.latitude, longitude=r.longitude, landmark=r.landmark),
                        timestamp=r.timestamp.isoformat() if r.timestamp else "",
                        snapshotDataUrl=r.snapshot_data_url
                    )
                )
        except Exception as e:
            # Fallback on DB query issue
            pass

    execution_time_ms = int((time.time() - start_time) * 1000)

    # Conversational summary
    count = len(results)
    col_str = "/".join(query.colors) + " " if query.colors else ""
    cls_str = "/".join(query.vehicleClasses) + "s" if query.vehicleClasses else "vehicles"
    summary = f"Enterprise PostGIS query returned {count} {col_str}{cls_str} [{execution_time_ms}ms]."

    return ForensicSearchResponse(
        query=query,
        summary=summary,
        matchedObservations=results,
        totalMatches=count,
        executionTimeMs=execution_time_ms,
        engine="enterprise_postgis",
        ambiguity=query.ambiguity
    )
