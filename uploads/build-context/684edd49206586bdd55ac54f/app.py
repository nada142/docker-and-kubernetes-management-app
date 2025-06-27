from flask import Flask, request, jsonify
from datetime import datetime
import random

app = Flask(__name__)

# Simulated weather conditions
WEATHER_CONDITIONS = ['☀️ Sunny', '☁️ Cloudy', '🌧️ Rainy', '🌩️ Stormy', '❄️ Snowy', '💨 Windy']

@app.route('/')
def home():
    return """
    <!DOCTYPE html>
    <html>
    <head>
        <title>Weather Info 🌦️</title>
    </head>
    <body style="font-family: Arial, sans-serif; padding: 30px;">
        <h1>🌤️ Weather Info App</h1>
        <p>Enter a city to get simulated weather data:</p>

        <input type="text" id="cityInput" placeholder="Enter city..." />
        <button onclick="getWeather()">Get Weather</button>

        <div id="result" style="margin-top: 20px;"></div>

        <script>
        async function getWeather() {
            const city = document.getElementById('cityInput').value;
            const resultDiv = document.getElementById('result');

            if (!city.trim()) {
                resultDiv.innerHTML = "<p style='color:red;'>Please enter a city name.</p>";
                return;
            }

            resultDiv.innerHTML = "Fetching weather...";

            try {
                const res = await fetch('/api/weather', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ city: city.trim() })
                });

                const data = await res.json();

                if (data.status === "error") {
                    resultDiv.innerHTML = `<p style='color:red;'>${data.message}</p>`;
                } else {
                    resultDiv.innerHTML = `
                        <h3>Weather for ${data.location.city}</h3>
                        <p>🌡️ Temperature: <strong>${data.weather.temperature.value} ${data.weather.temperature.unit}</strong></p>
                        <p>📍 Condition: <strong>${data.weather.condition}</strong></p>
                        <p>💡 Tip: ${data.tips}</p>
                        <p style="font-size: 12px; color: gray;">Timestamp: ${data.timestamp}</p>
                    `;
                }
            } catch (err) {
                resultDiv.innerHTML = "<p style='color:red;'>Failed to fetch weather data.</p>";
            }
        }
        </script>
    </body>
    </html>
    """

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
