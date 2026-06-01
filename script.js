const toggleSwitch = document.querySelector('.theme-switch input[type="checkbox"]');
const currentTheme = localStorage.getItem('theme');

// Apply saved theme on load
if (currentTheme) {
    document.body.classList.add(currentTheme);
    if (currentTheme === 'dark-mode') {
        toggleSwitch.checked = true;
    }
}

// Switch theme logic
function switchTheme(e) {
    if (e.target.checked) {
        document.body.classList.replace('light-mode', 'dark-mode');
        if(!document.body.classList.contains('dark-mode')) {
            document.body.classList.add('dark-mode');
        }
        localStorage.setItem('theme', 'dark-mode');
    } else {
        document.body.classList.replace('dark-mode', 'light-mode');
        if(!document.body.classList.contains('light-mode')) {
            document.body.classList.add('light-mode');
        }
        document.body.classList.remove('dark-mode');
        localStorage.setItem('theme', 'light-mode');
    }
}

toggleSwitch.addEventListener('change', switchTheme, false);