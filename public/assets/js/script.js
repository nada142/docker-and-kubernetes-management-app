document.addEventListener('DOMContentLoaded', function() {
    const dockerfileForm = document.getElementById('dockerfile-form');

    if (dockerfileForm) {
        dockerfileForm.addEventListener('submit', function(event) {
            event.preventDefault();

            const content = document.getElementById('dockerfile-content').value;
            const tag = event.target.tag.value;

            fetch('/dockerfile', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ dockerfileContent: content, tag: tag }),
            })
            .then(response => response.text())
            .then(data => alert(data))
            .catch(error => console.error('Error:', error));
        });
    }
});
