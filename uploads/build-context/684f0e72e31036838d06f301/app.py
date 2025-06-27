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
    <body style="font-family: Arial, sans-serif; padding: 30px; background-color: #f0f8ff;">
        <h1 style="color: #007acc;">🌤️ Weather Info App</h1>
        <p>Enter a city to get simulated weather data:</p>

        <input type="text" id="cityInput" placeholder="Enter city..." style="padding: 8px;" />
        <button onclick="getWeather()" style="padding: 8px; background-color: #007acc; color: white;">Get Weather</button>

        <div id="result" style="margin-top: 30px; padding: 20px; background-color: white; border-radius: 8px; box-shadow: 0 0 10px rgba(0,0,0,0.1);"></div>

        <script>
        function generateForecast() {
            const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
            return days.map(day => {
                const temp = (Math.random() * 15 + 15).toFixed(1);
                const conds = ['☀️', '🌧️', '☁️', '🌩️', '❄️'];
                const cond = conds[Math.floor(Math.random() * conds.length)];
                return `<li>${day}: ${cond} ${temp}°C</li>`;
            }).join('');
        }

        function getRandomQuote() {
            const quotes = [
                "There's no such thing as bad weather, only bad clothing.",
                "After rain comes sunshine. 🌈",
                "Climate is what we expect, weather is what we get.",
                "Storms make trees take deeper roots.",
                "Keep your face to the sun and you will never see the shadows."
            ];
            return quotes[Math.floor(Math.random() * quotes.length)];
        }

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
                        <h2>📍 ${data.location.city}, ${data.location.country}</h2>
                        <p>🌡️ <strong>${data.weather.temperature.value} ${data.weather.temperature.unit}</strong></p>
                        <p>🌥️ <strong>${data.weather.condition}</strong></p>
                        <p>💧 Humidity: ${Math.floor(Math.random()*50)+30}%</p>
                        <p>💨 Wind Speed: ${(Math.random()*10+5).toFixed(1)} km/h</p>
                        <p>🔆 UV Index: ${(Math.random()*8+2).toFixed(1)}</p>
                        <p>💡 Tip: ${data.tips}</p>
                        <hr>
                        <h3>7-Day Forecast</h3>
                        <ul>${generateForecast()}</ul>
                        <hr>
                        <p style="font-style: italic; color: #555;">"${getRandomQuote()}"</p>
                        <p style="font-size: 12px; color: gray;">🕓 ${data.timestamp}</p>
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
    app.run(host='0.0.0.0', port=5011)
