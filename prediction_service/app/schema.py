from pydantic import BaseModel
from typing import List, Optional
from datetime import datetime

class SingleDataPoint(BaseModel):
    CPU_Usage: float
    Memory_Usage: float
    Disk_Usage: float
    Network_Traffic: float
    Pod_Restarts: int
    Response_Time: float
    Timestamp: str
    Node: str
    Pod: str

class PredictionInput(BaseModel):
    sequence: List[SingleDataPoint]

class PredictionOutput(BaseModel):
    prediction: float
    anomaly: bool
    model: str
    confidence: float
    timestamp: str