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
