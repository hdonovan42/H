// Global variables
let map;
let waypoints = [];
let markers = [];
let routePolylines = [];
let draggedItem = null;

// Configure your API key here - using a demo key that may have limited functionality
const API_KEY = 'eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6IjA4MTc5OWFiZmUwOTQ2ZTY4ZWI1YzE2NTkxMjQ4MzVkIiwiaCI6Im11cm11cjY0In0=';

let routeSegments = [];
let totalStats = { distance: 0, duration: 0, hasFallbacks: false };

// Track if we need full recalculation
let needsFullRecalculation = false;
let lastCalculatedWaypointCount = 0;

// Initialize on load
window.onload = function() {
    initMap();
};

// Initialize map
function initMap() {
    map = L.map('map').setView([51.5074, -0.1278], 6); // London center
    
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
        subdomains: 'abcd',
        maxZoom: 20
    }).addTo(map);
}

// Get route segment between two waypoints
async function getRouteSegment(fromWaypoint, toWaypoint) {
    try {
        console.log(`Attempting API route from ${fromWaypoint.name} to ${toWaypoint.name}`);
        
        const response = await fetch('https://api.openrouteservice.org/v2/directions/driving-car', {
            method: 'POST',
            headers: {
                'Authorization': API_KEY,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                coordinates: [[fromWaypoint.lng, fromWaypoint.lat], [toWaypoint.lng, toWaypoint.lat]],
                radiuses: [10000, 10000] // 10km radius for each point
            })
        });

        // Check for HTTP errors
        if (!response.ok) {
            console.log(`API HTTP error ${response.status} for ${fromWaypoint.name} → ${toWaypoint.name}`);
            throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();
        
        // Check if routes exist and are valid
        if (!data.routes || data.routes.length === 0) {
            console.log(`No routes found for ${fromWaypoint.name} → ${toWaypoint.name}`);
            throw new Error('No routes found');
        }

        const route = data.routes[0];
        
        // Additional validation for route quality
        if (!route.geometry || !route.summary) {
            console.log(`Invalid route data for ${fromWaypoint.name} → ${toWaypoint.name}`);
            throw new Error('Invalid route data');
        }

        // Check if the route distance is reasonable
        const routeDistance = route.summary.distance / 1000;
        const straightLineDistance = calculateDistance(
            fromWaypoint.lat, fromWaypoint.lng,
            toWaypoint.lat, toWaypoint.lng
        );
        
        // If API route is suspiciously shorter than straight line, it might be invalid
        if (routeDistance < straightLineDistance * 0.8) {
            console.log(`API route suspiciously short for ${fromWaypoint.name} → ${toWaypoint.name}`);
            throw new Error('Invalid route - too short');
        }
        
        // If API route is excessively longer than straight line (indicating impractical routing like ferries)
        // For short distances (<50km), be more strict about detours
        const maxRatio = straightLineDistance < 50 ? 2.0 : 2.0;
        if (routeDistance > straightLineDistance * maxRatio) {
            console.log(`API route too long for ${fromWaypoint.name} → ${toWaypoint.name}: ${routeDistance.toFixed(1)}km vs ${straightLineDistance.toFixed(1)}km direct (${(routeDistance/straightLineDistance).toFixed(1)}x longer)`);
            throw new Error(`Impractical route - ${(routeDistance/straightLineDistance).toFixed(1)}x longer than direct`);
        }
        
        // Additional check for ferry/tunnel routes by looking at duration
        const routeDuration = route.summary.duration / 3600; // hours
        const expectedDuration = straightLineDistance / 80; // assuming 80km/h
        
        // If route takes much longer than expected, it might involve ferries/tunnels
        if (routeDuration > expectedDuration * 3 && straightLineDistance < 100) {
            console.log(`API route too slow for ${fromWaypoint.name} → ${toWaypoint.name}: ${routeDuration.toFixed(1)}h vs ${expectedDuration.toFixed(1)}h expected`);
            throw new Error(`Impractical route - involves ferry/tunnel`);
        }

        // Decode the route geometry
        const decodedCoords = decodePolyline(route.geometry);
        
        console.log(`✓ API route found for ${fromWaypoint.name} → ${toWaypoint.name}`);
        
        return {
            coordinates: decodedCoords,
            distance: routeDistance,
            duration: route.summary.duration / 3600, // Convert to hours
            type: 'api'
        };
        
    } catch (error) {
        console.log(`🔄 API failed for ${fromWaypoint.name} → ${toWaypoint.name}, using fallback: ${error.message}`);
        
        // Fallback to straight line calculation
        const distance = calculateDistance(
            fromWaypoint.lat, fromWaypoint.lng,
            toWaypoint.lat, toWaypoint.lng
        );
        
        // Estimate duration assuming 80 km/h average speed for fallback
        const duration = distance / 80;
        
        return {
            coordinates: [[fromWaypoint.lat, fromWaypoint.lng], [toWaypoint.lat, toWaypoint.lng]],
            distance: distance,
            duration: duration,
            type: 'fallback'
        };
    }
}

// OPTIMIZED: Incremental route calculation
async function calculateRoute() {
    if (waypoints.length < 2) {
        routeSegments = [];
        totalStats = { distance: 0, duration: 0 };
        lastCalculatedWaypointCount = waypoints.length;
        return;
    }

    console.log('Starting optimized route calculation...');
    
    // Check if we can do incremental calculation
    const isIncremental = !needsFullRecalculation && 
                         waypoints.length === lastCalculatedWaypointCount + 1 && 
                         routeSegments.length === waypoints.length - 2;

    if (isIncremental) {
        console.log('🚀 Using incremental calculation - adding only new segment');
        
        // Only calculate the route from the second-to-last to the last waypoint
        const fromWaypoint = waypoints[waypoints.length - 2];
        const toWaypoint = waypoints[waypoints.length - 1];
        
        const newSegment = await getRouteSegment(fromWaypoint, toWaypoint);
        routeSegments.push(newSegment);
        
        // Update totals incrementally
        totalStats.distance += newSegment.distance;
        totalStats.duration += newSegment.duration;
        
        console.log('✅ Incremental calculation complete - 1 API call used');
    } else {
        console.log('🔄 Full recalculation needed');
        
        // Full recalculation - calculate all segments step by step
        routeSegments = [];
        totalStats = { distance: 0, duration: 0 };

        for (let i = 0; i < waypoints.length - 1; i++) {
            const fromWaypoint = waypoints[i];
            const toWaypoint = waypoints[i + 1];
            
            console.log(`Calculating segment ${i + 1}/${waypoints.length - 1}: ${fromWaypoint.name} → ${toWaypoint.name}`);
            
            const segment = await getRouteSegment(fromWaypoint, toWaypoint);
            routeSegments.push(segment);
            
            totalStats.distance += segment.distance;
            totalStats.duration += segment.duration;
        }
        
        console.log(`✅ Full recalculation complete - ${waypoints.length - 1} API calls used`);
    }
    
    // Reset flags
    needsFullRecalculation = false;
    lastCalculatedWaypointCount = waypoints.length;
}

// Decode polyline (OpenRouteService returns encoded polylines)
function decodePolyline(encoded) {
    const points = [];
    let index = 0;
    let lat = 0;
    let lng = 0;

    while (index < encoded.length) {
        let shift = 0;
        let result = 0;
        let byte;

        do {
            byte = encoded.charCodeAt(index++) - 63;
            result |= (byte & 0x1f) << shift;
            shift += 5;
        } while (byte >= 0x20);

        const dlat = ((result & 1) ? ~(result >> 1) : (result >> 1));
        lat += dlat;

        shift = 0;
        result = 0;

        do {
            byte = encoded.charCodeAt(index++) - 63;
            result |= (byte & 0x1f) << shift;
            shift += 5;
        } while (byte >= 0x20);

        const dlng = ((result & 1) ? ~(result >> 1) : (result >> 1));
        lng += dlng;

        points.push([lat * 1e-5, lng * 1e-5]);
    }

    return points;
}

// Format address to show only: Name, City, Country
function formatAddress(geocodeData) {
    if (!geocodeData || !geocodeData.address) {
        return 'Unknown location';
    }
    
    const addr = geocodeData.address;
    const parts = [];
    
    // Get the main place name (city, town, village, etc.)
    const placeName = addr.city || addr.town || addr.village || addr.hamlet || 
                     addr.suburb || addr.neighbourhood || addr.county;
    
    if (placeName) {
        parts.push(placeName);
    }
    
    // Get country
    if (addr.country) {
        parts.push(addr.country);
    }
    
    return parts.length > 0 ? parts.join(', ') : 'Unknown location';
}

// Format search result name to be concise
function formatSearchResultName(result) {
    console.log('Search result data:', result); // Debug log
    
    if (!result.address) {
        console.log('No address object, using display_name');
        // Fallback: try to extract city and country from display_name
        const parts = result.display_name.split(',').map(p => p.trim());
        if (parts.length >= 2) {
            return `${parts[0]}, ${parts[parts.length - 1]}`; // First part, last part
        }
        return parts[0];
    }
    
    const addr = result.address;
    console.log('Address object:', addr); // Debug log
    const parts = [];
    
    // Get the main place name
    const mainName = addr.city || addr.town || addr.village || addr.hamlet || 
                    addr.suburb || addr.neighbourhood || 
                    result.display_name.split(',')[0];
    
    if (mainName) {
        parts.push(mainName);
    }
    
    // Add country
    if (addr.country) {
        parts.push(addr.country);
    }
    
    return parts.length > 0 ? parts.join(', ') : result.display_name.split(',')[0];
}

// MODIFIED: Add waypoint with optimization flag
function addWaypoint(lat, lng, name = null) {
    const waypoint = {
        id: Date.now(),
        lat: lat,
        lng: lng,
        name: name || `Waypoint ${waypoints.length + 1}`,
        address: name ? '' : 'Loading address...'
    };

    waypoints.push(waypoint);
    
    // Don't set needsFullRecalculation for simple additions
    // The calculateRoute function will handle incremental calculation
    
    updateUI();
    
    // Reverse geocode to get address if name not provided
    if (!name) {
        reverseGeocode(lat, lng, waypoint.id);
    }
}

// Reverse geocode
async function reverseGeocode(lat, lng, waypointId) {
    try {
        const response = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}`);
        const data = await response.json();
        
        const waypoint = waypoints.find(w => w.id === waypointId);
        if (waypoint) {
            waypoint.address = formatAddress(data);
            updateUI();
        }
    } catch (error) {
        console.error('Geocoding error:', error);
    }
}

// Update UI
async function updateUI() {
    updateWaypointsList();
    await updateMap();
    updateStats();
}

// Update waypoints list
function updateWaypointsList() {
    const container = document.getElementById('waypointsList');
    
    if (waypoints.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-map-marked-alt"></i>
                <p>No waypoints added yet</p>
                <p>Search for locations to get started</p>
            </div>
        `;
        return;
    }

    container.innerHTML = waypoints.map((waypoint, index) => {
        let routeInfo = '';
        if (index > 0 && routeSegments.length >= index) {
            const segment = routeSegments[index - 1];
            if (segment) {
                const fallbackClass = segment.type === 'fallback' ? 'fallback' : '';
                const routeTypeText = segment.type === 'fallback' ? 'Direct' : 'Road';
                
                routeInfo = `
                    <div class="waypoint-route-info ${fallbackClass}">
                        <span><i class="fas fa-road"></i>${segment.distance.toFixed(1)} km</span>
                        <span><i class="fas fa-clock"></i>${Math.floor(segment.duration)}h ${Math.round((segment.duration % 1) * 60)}m</span>
                        <span class="route-type">${routeTypeText}</span>
                    </div>
                `;
            }
        }
        
        return `
            <div class="waypoint-item" draggable="true" data-id="${waypoint.id}">
                <div class="waypoint-header">
                    <div class="waypoint-number">${index + 1}</div>
                    <div class="waypoint-name">${waypoint.name}</div>
                    <div class="waypoint-actions">
                        <button class="waypoint-action" onclick="editWaypoint(${waypoint.id})">
                            <i class="fas fa-edit"></i>
                        </button>
                        <button class="waypoint-action delete" onclick="removeWaypoint(${waypoint.id})">
                            <i class="fas fa-trash"></i>
                        </button>
                    </div>
                </div>
                ${routeInfo}
            </div>
        `;
    }).join('');

    // Add drag and drop handlers
    addDragHandlers();
}

// Update map
async function updateMap() {
    // Clear existing markers and routes
    markers.forEach(marker => map.removeLayer(marker));
    markers = [];
    
    routePolylines.forEach(polyline => map.removeLayer(polyline));
    routePolylines = [];

    // Add markers
    waypoints.forEach((waypoint, index) => {
        const marker = L.marker([waypoint.lat, waypoint.lng], {
            icon: L.divIcon({
                className: 'custom-marker',
                html: `<div style="background: #007AFF; color: white; width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: bold; box-shadow: 0 2px 8px rgba(0,0,0,0.3);">${index + 1}</div>`,
                iconSize: [32, 32],
                iconAnchor: [16, 16]
            })
        }).addTo(map);

        marker.bindPopup(`<strong>${waypoint.name}</strong><br>${waypoint.address}`);
        markers.push(marker);
    });

    // Calculate and draw routes
    if (waypoints.length > 1) {
        await calculateRoute();
        
        // Draw route segments
        routeSegments.forEach((segment, index) => {
            const color = segment.type === 'fallback' ? '#FF9500' : '#007AFF';
            const dashArray = segment.type === 'fallback' ? '8, 4' : null;
            
            const polyline = L.polyline(segment.coordinates, {
                color: color,
                weight: 4,
                opacity: 0.8,
                dashArray: dashArray
            }).addTo(map);
            
            routePolylines.push(polyline);
        });

        // Fit map to bounds
        if (routePolylines.length > 0) {
            const group = new L.featureGroup(routePolylines);
            map.fitBounds(group.getBounds(), { padding: [50, 50] });
        }
    } else if (waypoints.length === 1) {
        map.setView([waypoints[0].lat, waypoints[0].lng], 12);
    }
}

// Update stats
function updateStats() {
    document.getElementById('totalDistance').textContent = `${totalStats.distance.toFixed(1)} km`;
    document.getElementById('estimatedTime').textContent = `${Math.floor(totalStats.duration)}h ${Math.round((totalStats.duration % 1) * 60)}m`;
    document.getElementById('waypointCount').textContent = waypoints.length;
}

// Calculate distance between two points (Haversine formula)
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // Radius of the Earth in km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = 
        Math.sin(dLat/2) * Math.sin(dLat/2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
}

// MODIFIED: Remove waypoint with optimization logic
function removeWaypoint(id) {
    const removedIndex = waypoints.findIndex(w => w.id === id);
    
    if (removedIndex === -1) return;
    
    // Remove the waypoint
    waypoints = waypoints.filter(w => w.id !== id);
    
    // Determine if we need full recalculation
    if (removedIndex === waypoints.length) {
        // Removed the last waypoint - can just remove the last segment
        console.log('🗑️ Removed last waypoint - removing last segment only');
        if (routeSegments.length > 0) {
            const removedSegment = routeSegments.pop();
            totalStats.distance -= removedSegment.distance;
            totalStats.duration -= removedSegment.duration;
        }
        lastCalculatedWaypointCount = waypoints.length;
    } else {
        // Removed a waypoint that's not the last - need full recalculation
        console.log('🗑️ Removed middle waypoint - flagging for full recalculation');
        needsFullRecalculation = true;
        routeSegments = [];
        totalStats = { distance: 0, duration: 0 };
    }
    
    updateUI();
}

// Edit waypoint
function editWaypoint(id) {
    const waypoint = waypoints.find(w => w.id === id);
    if (waypoint) {
        const newName = prompt('Enter new name:', waypoint.name);
        if (newName) {
            waypoint.name = newName;
            updateUI();
        }
    }
}

// MODIFIED: Reset trip with optimization flags
function resetTrip() {
    if (waypoints.length > 0 && !confirm('Are you sure you want to reset the trip?')) {
        return;
    }
    waypoints = [];
    routeSegments = [];
    totalStats = { distance: 0, duration: 0 };
    needsFullRecalculation = false;
    lastCalculatedWaypointCount = 0;
    updateUI();
}

// Toggle sidebar
function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    sidebar.classList.toggle('collapsed');
}

// MODIFIED: Drag and drop handlers with optimization logic
function addDragHandlers() {
    const items = document.querySelectorAll('.waypoint-item');
    
    items.forEach(item => {
        item.addEventListener('dragstart', handleDragStart);
        item.addEventListener('dragend', handleDragEnd);
        item.addEventListener('dragover', handleDragOver);
        item.addEventListener('drop', handleDrop);
    });
}

function handleDragStart(e) {
    draggedItem = this;
    this.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/html', this.innerHTML);
}

function handleDragEnd(e) {
    this.classList.remove('dragging');
}

function handleDragOver(e) {
    if (e.preventDefault) {
        e.preventDefault();
    }
    e.dataTransfer.dropEffect = 'move';
    return false;
}

function handleDrop(e) {
    if (e.stopPropagation) {
        e.stopPropagation();
    }

    if (draggedItem !== this) {
        const draggedId = parseInt(draggedItem.dataset.id);
        const targetId = parseInt(this.dataset.id);
        
        const draggedIndex = waypoints.findIndex(w => w.id === draggedId);
        const targetIndex = waypoints.findIndex(w => w.id === targetId);
        
        // Swap waypoints
        const [removed] = waypoints.splice(draggedIndex, 1);
        waypoints.splice(targetIndex, 0, removed);
        
        // Reordering always requires full recalculation
        console.log('🔄 Waypoints reordered - flagging for full recalculation');
        needsFullRecalculation = true;
        routeSegments = [];
        totalStats = { distance: 0, duration: 0 };
        updateUI();
    }

    return false;
}

// Search functionality
document.getElementById('searchInput').addEventListener('keypress', async function(e) {
    if (e.key === 'Enter') {
        const query = this.value.trim();
        if (query) {
            try {
                const response = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}`);
                const results = await response.json();
                
                if (results.length > 0) {
                    const result = results[0];
                    const simpleName = formatSearchResultName(result);
                    addWaypoint(parseFloat(result.lat), parseFloat(result.lon), simpleName);
                    this.value = '';
                } else {
                    alert('Location not found');
                }
            } catch (error) {
                console.error('Search error:', error);
                alert('Error searching for location');
            }
        }
    }
});