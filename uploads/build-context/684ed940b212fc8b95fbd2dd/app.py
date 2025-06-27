from flask import Flask, request, jsonify, send_from_directory
from datetime import datetime
import random
import os

app = Flask(__name__)

BASE_DIR = os.path.abspath(os.path.dirname(__file__))

# Simulated weather conditions
WEATHER_CONDITIONS = ['☀️ Sunny', '☁️ Cloudy', '🌧️ Rainy', '🌩️ Stormy', '❄️ Snowy', '💨 Windy']

@app.route('/')
def home():
    return send_from_directory(BASE_DIR, 'index.html')

@app.route('/script.js')
def script():
    return send_from_directory(BASE_DIR, 'script.js')

@app.route('/api/weather', methods=['POST'])
def get_weather():
    data = request.get_json()
    city = data.get('city')

    if not city:
        return jsonify({
            "status": "error",
            "message": "Missing 'city' in request body",
            "timestamp": datetime.utcnow().isoformat() + "Z"
        }), 400

    temperature = round(random.uniform(10.0, 35.0), 1)
    condition = random.choice(WEATHER_CONDITIONS)

    return jsonify({
        "status": "success",
        "timestamp": datetime.utcnow().isoformat() + "Z",
        "location": {
            "city": city.title(),
            "country": "Simulated Land 🌍"
        },
        "weather": {
            "temperature": {
                "value": temperature,
                "unit": "°C"
            },
            "condition": condition
        },
        "tips": "Stay hydrated! 💧" if temperature > 28 else "Have a nice day! 😊"
    })

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5002)
