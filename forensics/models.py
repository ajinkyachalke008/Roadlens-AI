import uuid
from datetime import datetime
from sqlalchemy import Column, String, Integer, Float, DateTime, JSON, Index
from forensics.database import Base

class VehicleObservationModel(Base):
    __tablename__ = "vehicle_observations"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    vehicle_id = Column(String, index=True, nullable=False)
    track_id = Column(Integer, nullable=True)
    vehicle_class = Column(String, index=True, nullable=False)

    # Color attributes
    color_name = Column(String, index=True, nullable=False)
    color_hex = Column(String, nullable=False)
    color_confidence = Column(Float, default=0.0)

    # Plate attributes
    plate_number = Column(String, index=True, nullable=True)
    plate_state_code = Column(String, index=True, nullable=True)
    plate_state_name = Column(String, nullable=True)
    rto_location = Column(String, nullable=True)
    plate_confidence = Column(Float, default=0.0)

    # Kinematics
    speed_kmh = Column(Float, index=True, nullable=True)
    speed_mps = Column(Float, nullable=True)
    is_speeding = Column(String, default="false")  # "true" / "false"
    speed_confidence = Column(Float, default=0.0)

    # Safety
    violations = Column(JSON, default=list)

    # Camera & Geo
    camera_id = Column(String, index=True, nullable=False)
    camera_name = Column(String, nullable=False)
    latitude = Column(Float, nullable=False)
    longitude = Column(Float, nullable=False)
    landmark = Column(String, nullable=True)

    timestamp = Column(DateTime, index=True, default=datetime.utcnow)
    snapshot_data_url = Column(String, nullable=True)

    __table_args__ = (
        Index("idx_obs_plate_timestamp", "plate_number", "timestamp"),
        Index("idx_obs_class_speed", "vehicle_class", "speed_kmh"),
    )
