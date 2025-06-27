import json
import numpy as np
import pandas as pd
from sklearn.preprocessing import StandardScaler
from tensorflow.keras.models import load_model
import os
import logging
from typing import List, Dict

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Force CPU usage and suppress TensorFlow logging
os.environ['TF_CPP_MIN_LOG_LEVEL'] = '2'
os.environ['CUDA_VISIBLE_DEVICES'] = '-1'

class LSTMPredictor:
    def __init__(self):
        """Initialize the LSTM predictor with scaler and model"""
        try:
            # Load scaler parameters
            with open('models/scaler_params.json', 'r') as f:
                self.scaler_params = json.load(f)
            
            # Initialize scaler
            self.scaler = StandardScaler()
            self.scaler.mean_ = np.array([self.scaler_params[col]['mean'] for col in self.scaler_params])
            self.scaler.scale_ = np.array([self.scaler_params[col]['std'] for col in self.scaler_params])
            
            # Load LSTM model
            self.model = load_model('models/lstm_anomaly_model.h5')
            logger.info("LSTM model loaded successfully")
            
            # Store expected sequence length from training
            self.sequence_length = 15
            
            # Load expected feature names
            with open('models/feature_names.json', 'r') as f:
                self.training_features = json.load(f)
            
        except Exception as e:
            logger.error(f"Failed to initialize predictor: {str(e)}")
            raise

    def preprocess_data(self, data: List[Dict]) -> pd.DataFrame:
        """Preprocess time-series data for LSTM model"""
        try:
            # Create DataFrame from sequence
            df = pd.DataFrame(data)
            
            # Ensure all required features are present
            for col in self.training_features:
                if col not in df.columns:
                    df[col] = 0
            
            # Calculate derived features
            df['Network_Response_Ratio'] = df['Network_Traffic'] / (df['Response_Time'] + 1e-6)
            df['Pod_Restarts_Flag'] = (df['Pod_Restarts'] > 0).astype(int)
            
            # Scale numerical features
            numerical_cols = list(self.scaler_params.keys())
            df[numerical_cols] = self.scaler.transform(df[numerical_cols])
            
            # Sort by Timestamp to ensure correct sequence order
            df = df.sort_values('Timestamp')
            
            return df[self.training_features]
        
        except Exception as e:
            logger.error(f"Data preprocessing failed: {str(e)}")
            raise
        
    def _create_sequence(self, df: pd.DataFrame) -> np.ndarray:
        """Create sequence data for LSTM prediction"""
        try:
            # Verify feature count
            if len(df.columns) != len(self.training_features):
                missing = set(self.training_features) - set(df.columns)
                extra = set(df.columns) - set(self.training_features)
                logger.error(f"Feature mismatch! Missing: {missing}, Extra: {extra}")
                raise ValueError(f"Feature count mismatch: expected {len(self.training_features)}, got {len(df.columns)}")
            
            # If sequence is shorter than required, pad with last values
            if len(df) < self.sequence_length:
                last_row = df.iloc[-1:].copy()
                pad_rows = pd.concat([last_row] * (self.sequence_length - len(df)), ignore_index=True)
                df = pd.concat([df, pad_rows], ignore_index=True)
            
            # If sequence is longer, take most recent
            if len(df) > self.sequence_length:
                df = df.tail(self.sequence_length)
            
            return df[self.training_features].values.reshape(1, self.sequence_length, -1)
        
        except Exception as e:
            logger.error(f"Sequence creation failed: {str(e)}")
            raise

    def predict(self, data: List[Dict]) -> Dict:
        """Make prediction using LSTM model"""
        try:
            logger.info("Starting prediction")
            
            # Validate input sequence
            if not data or len(data) == 0:
                raise ValueError("Empty input sequence")
            
            # Preprocess data
            logger.info("Preprocessing data")
            processed_df = self.preprocess_data(data)
            logger.info(f"Processed DataFrame shape: {processed_df.shape}")
            
            # Create sequence
            logger.info("Creating sequence")
            sequence = self._create_sequence(processed_df)
            logger.info(f"Sequence shape: {sequence.shape}")
            
            # Make prediction
            logger.info("Making prediction")
            prediction = self.model.predict(sequence, verbose=0)
            logger.info(f"Raw prediction: {prediction}")
            
            # Return results
            result = {
                'prediction': float(prediction[0][0]),
                'anomaly': bool(prediction[0][0] > 0.75),
                'model': 'LSTM',
                'confidence': float(prediction[0][0]),
                'timestamp': data[-1]['Timestamp']
            }
            logger.info(f"Prediction result: {result}")
            return result
                
        except Exception as e:
            logger.error(f"Prediction failed: {str(e)}", exc_info=True)
            raise