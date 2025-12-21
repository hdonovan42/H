const car1Input = document.getElementById('car1-input');
const car2Input = document.getElementById('car2-input');
const autocomplete1 = document.getElementById('autocomplete1');
const autocomplete2 = document.getElementById('autocomplete2');
const comparisonGrid = document.getElementById('comparison-grid');

let selectedCar1 = null;
let selectedCar2 = null;
let currentFocus = -1;

function createCarCard(car, otherCar = null) {
    const specs = [
        { label: 'Horsepower', value: car.hp, unit: 'HP', key: 'hp' },
        { label: '0-60 MPH', value: car.zeroToSixty, unit: 'sec', key: 'zeroToSixty', reverse: true },
        { label: 'Top Speed', value: car.topSpeed, unit: 'mph', key: 'topSpeed' },
        { label: 'Cylinders', value: car.cylinders, unit: '', key: 'cylinders' },
        { label: 'Engine Placement', value: car.enginePlacement, unit: '', key: 'enginePlacement' },
        { label: 'Drivetrain', value: car.drivetrain, unit: '', key: 'drivetrain' },
        { label: 'Weight', value: car.weight.toLocaleString(), unit: 'lbs', key: 'weight', reverse: true }
    ];

    const specsHTML = specs.map(spec => {
        let highlight = '';
        if (otherCar && typeof car[spec.key] === 'number' && typeof otherCar[spec.key] === 'number') {
            const isBetter = spec.reverse ? 
                car[spec.key] < otherCar[spec.key] : 
                car[spec.key] > otherCar[spec.key];
            highlight = isBetter ? 'highlight' : '';
        }

        const unitHTML = spec.unit ? `<span class="spec-unit">${spec.unit}</span>` : '';

        return `
            <li class="spec-item ${highlight}">
                <span class="spec-label">${spec.label}</span>
                <span class="spec-value">${spec.value}${unitHTML}</span>
            </li>
        `;
    }).join('');

    return `
        <div class="car-card">
            <div class="car-header">
                <div class="car-name">${car.make} ${car.model}</div>
                <div class="car-year">${car.year}</div>
            </div>
            <ul class="spec-list">
                ${specsHTML}
            </ul>
        </div>
    `;
}

function updateComparison() {
    if (!selectedCar1 && !selectedCar2) {
        comparisonGrid.innerHTML = '';
        return;
    }

    let html = '';
    if (selectedCar1) html += createCarCard(selectedCar1, selectedCar2);
    if (selectedCar2) html += createCarCard(selectedCar2, selectedCar1);

    comparisonGrid.innerHTML = html;
}

function getCarName(car) {
    return `${car.year} ${car.make} ${car.model}`;
}

function filterCars(searchTerm) {
    if (!searchTerm) return carsDatabase;
    
    const term = searchTerm.toLowerCase();
    return carsDatabase.filter(car => {
        const fullName = getCarName(car).toLowerCase();
        return fullName.includes(term);
    });
}

function showAutocomplete(input, autocompleteDiv, carNumber) {
    const searchTerm = input.value;
    const matches = filterCars(searchTerm);
    
    autocompleteDiv.innerHTML = '';
    currentFocus = -1;
    
    if (matches.length === 0 || !searchTerm) {
        autocompleteDiv.classList.remove('active');
        return;
    }

    matches.forEach((car, index) => {
        const div = document.createElement('div');
        div.className = 'autocomplete-item';
        div.textContent = getCarName(car);
        div.addEventListener('click', () => selectCar(car, input, autocompleteDiv, carNumber));
        autocompleteDiv.appendChild(div);
    });

    autocompleteDiv.classList.add('active');
    
    // Automatically highlight first item
    currentFocus = 0;
    const items = autocompleteDiv.querySelectorAll('.autocomplete-item');
    setActive(items);
}

function selectCar(car, input, autocompleteDiv, carNumber) {
    input.value = getCarName(car);
    if (carNumber === 1) {
        selectedCar1 = car;
    } else {
        selectedCar2 = car;
    }
    autocompleteDiv.classList.remove('active');
    updateComparison();
}

function handleKeydown(e, autocompleteDiv, input, carNumber) {
    const items = autocompleteDiv.querySelectorAll('.autocomplete-item');
    
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        currentFocus++;
        if (currentFocus >= items.length) currentFocus = 0;
        setActive(items);
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        currentFocus--;
        if (currentFocus < 0) currentFocus = items.length - 1;
        setActive(items);
    } else if (e.key === 'Enter') {
        e.preventDefault();
        if (currentFocus > -1 && items[currentFocus]) {
            items[currentFocus].click();
            // After selection, move to next input or blur
            if (carNumber === 1) {
                car2Input.focus();
            } else if (carNumber === 2) {
                input.blur();
            }
        }
    } else if (e.key === 'Escape') {
        autocompleteDiv.classList.remove('active');
    }
}

function setActive(items) {
    items.forEach((item, index) => {
        item.classList.remove('active');
        if (index === currentFocus) {
            item.classList.add('active');
            item.scrollIntoView({ block: 'nearest' });
        }
    });
}

// Event listeners for car 1
car1Input.addEventListener('input', () => showAutocomplete(car1Input, autocomplete1, 1));
car1Input.addEventListener('keydown', (e) => handleKeydown(e, autocomplete1, car1Input, 1));
car1Input.addEventListener('focus', () => showAutocomplete(car1Input, autocomplete1, 1));

// Event listeners for car 2
car2Input.addEventListener('input', () => showAutocomplete(car2Input, autocomplete2, 2));
car2Input.addEventListener('keydown', (e) => handleKeydown(e, autocomplete2, car2Input, 2));
car2Input.addEventListener('focus', () => showAutocomplete(car2Input, autocomplete2, 2));

// Close autocomplete when clicking outside
document.addEventListener('click', (e) => {
    if (!e.target.closest('.input-wrapper')) {
        autocomplete1.classList.remove('active');
        autocomplete2.classList.remove('active');
    }
});

// Keyboard shortcut to clear
document.addEventListener('keydown', (e) => {
    if (e.key === 'c' || e.key === 'C') {
        // Don't trigger if user is typing in an input
        if (e.target.tagName === 'INPUT') return;
        
        // Clear everything
        car1Input.value = '';
        car2Input.value = '';
        selectedCar1 = null;
        selectedCar2 = null;
        autocomplete1.classList.remove('active');
        autocomplete2.classList.remove('active');
        updateComparison();
    }
});

// Initialize
updateComparison();