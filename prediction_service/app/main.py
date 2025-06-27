from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from app.predict import LSTMPredictor
from app.schema import PredictionInput
import logging

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI()

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/health")
async def health_check():
    """Health check endpoint"""
    try:
        if not hasattr(predictor, 'model'):
            raise Exception("Model not loaded")
        return {
            "status": "healthy",
            "model_loaded": True,
            "using_gpu": False
        }
    except Exception as e:
        logger.error(f"Health check failed: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/predict")
async def predict(data: PredictionInput):
    """Make anomaly prediction for time-series data"""
    try:
        # Convert Pydantic model to list of dicts
        input_data = [item.dict() for item in data.sequence]
        logger.info(f"Received prediction request for {input_data[0]['Pod']}")
        logger.debug(f"Input sequence length: {len(input_data)}")
        
        # Make prediction
        result = predictor.predict(input_data)
        
        # Log prediction result
        logger.info(f"Prediction result: {result}")
        
        return result
        
    except Exception as e:
        logger.error(f"Prediction error: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail={
                "error": "Prediction failed",
                "message": str(e),
                "input_features": [list(item.keys()) for item in input_data] if 'input_data' in locals() else None
            }
        )

# Initialize predictor
predictor = LSTMPredictor()