from typing import Optional, List, Dict, Any
from pydantic import BaseModel, Field

class ColorAttribute(BaseModel):
    name: str
    hex: str
    confidence: float

class PlateAttribute(BaseModel):
    text: Optional[str] = None
    stateCode: Optional[str] = None
    stateName: Optional[str] = None
    rtoLocation: Optional[str] = None
    confidence: float = 0.0

class SpeedAttribute(BaseModel):
    kmh: Optional[float] = None
    mps: Optional[float] = None
    isSpeeding: bool = False
    confidence: float = 0.0

class GeoLocation(BaseModel):
    latitude: float
    longitude: float
    accuracyM: Optional[float] = None
    landmark: Optional[str] = None

class ForensicObservationSchema(BaseModel):
    id: str
    reportId: Optional[str] = None
    trackId: Optional[int] = None
    vehicleClass: str
    color: ColorAttribute
    plate: PlateAttribute
    speed: SpeedAttribute
    violations: List[str] = []
    cameraId: str
    cameraName: str
    location: GeoLocation
    timestamp: str
    sourceMode: Optional[str] = None
    snapshotDataUrl: Optional[str] = None
    evidenceId: Optional[str] = None

class ForensicSearchRequest(BaseModel):
    query: str

class AmbiguityOption(BaseModel):
    label: str
    query: str
    description: Optional[str] = None

class AmbiguityClarification(BaseModel):
    isAmbiguous: bool
    reason: Optional[str] = None
    options: List[AmbiguityOption] = []

class TrafficQueryAST(BaseModel):
    rawQuery: str
    intent: str
    vehicleClasses: List[str] = []
    colors: List[str] = []
    plate: Optional[Dict[str, Any]] = None
    speed: Optional[Dict[str, Any]] = None
    violations: List[str] = []
    timeRange: Optional[Dict[str, Any]] = None
    sort: str = "timestamp_desc"
    limit: int = 100
    ambiguity: Optional[AmbiguityClarification] = None

class ForensicSearchResponse(BaseModel):
    query: TrafficQueryAST
    summary: str
    matchedObservations: List[ForensicObservationSchema]
    totalMatches: int
    executionTimeMs: int
    engine: str = "enterprise_postgis"
    ambiguity: Optional[AmbiguityClarification] = None
