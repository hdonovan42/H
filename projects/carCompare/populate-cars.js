#!/usr/bin/env node
/**
 * Car Data Populator - CLI Tool
 * 
 * Populates car database using LLM with:
 * - Structured Generation (JSON schema enforcement)
 * - RAG (Retrieval Augmented Generation via web search)
 * - Verification Pipeline (multi-source cross-checking)
 *  
 *  Configuration:
 *  Create a .env file with: ANTHROPIC_API_KEY=sk-ant-...
 
 * 
 * Usage:
 *   node populate-cars.js "Porsche 911 GT3 2024" "BMW M3 2024"
 *   
 * Or with a file:
 *   node populate-cars.js --file cars-to-lookup.txt
 * 
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// ============================================================================
// LOAD .env FILE
// ============================================================================

function loadEnvFile() {
    const envPath = path.join(process.cwd(), '.env');
    
    if (fs.existsSync(envPath)) {
        const envContent = fs.readFileSync(envPath, 'utf-8');
        const lines = envContent.split('\n');
        
        for (const line of lines) {
            const trimmed = line.trim();
            // Skip empty lines and comments
            if (!trimmed || trimmed.startsWith('#')) continue;
            
            const eqIndex = trimmed.indexOf('=');
            if (eqIndex > 0) {
                const key = trimmed.substring(0, eqIndex).trim();
                let value = trimmed.substring(eqIndex + 1).trim();
                
                // Remove surrounding quotes if present
                if ((value.startsWith('"') && value.endsWith('"')) ||
                    (value.startsWith("'") && value.endsWith("'"))) {
                    value = value.slice(1, -1);
                }
                
                // Only set if not already in environment
                if (!process.env[key]) {
                    process.env[key] = value;
                }
            }
        }
        return true;
    }
    return false;
}

// Load .env before accessing CONFIG
const envLoaded = loadEnvFile();

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: 'claude-sonnet-4-5-20250929',  // Claude Sonnet 4.5 (or use 'claude-sonnet-4-5' alias)
    maxTokens: 4096,
    enableRag: true,           // Enable web search for RAG
    enableVerification: true,  // Enable multi-source verification
    strictSchemaValidation: true,
    outputFile: 'data.js',
    retryAttempts: 3,
    retryDelay: 2000,          // 2 seconds base delay
    delayBetweenCars: 3000,    // 3 seconds between each car
    rateLimitDelay: 60000      // 60 seconds if rate limited
};

// ============================================================================
// CAR SCHEMA DEFINITION
// ============================================================================

const CAR_SCHEMA = {
    type: "object",
    properties: {
        id: { type: "integer", description: "Unique identifier" },
        make: { type: "string", description: "Car manufacturer (e.g., Porsche, BMW)" },
        model: { type: "string", description: "Model name (e.g., 911 GT3, M3 Competition)" },
        generation: { type: "string", description: "Generation/chassis code (e.g., 992, 997, G80, W206). Use the manufacturer's internal code." },
        modelYears: { type: "string", description: "Production year range for this generation (e.g., '2019-2024', '2014-2019')" },
        year: { type: "integer", description: "Specific model year for these specs" },
        hp: { type: "integer", description: "Horsepower" },
        zeroToSixty: { type: "number", description: "0-60 mph time in seconds" },
        topSpeed: { type: "integer", description: "Top speed in mph" },
        cylinders: { type: "integer", description: "Number of cylinders (0 for electric)" },
        displacement: { type: "number", description: "Engine displacement in liters (0 for electric)" },
        enginePlacement: { 
            type: "string", 
            enum: ["Front", "Mid", "Rear", "N/A"], 
            description: "Engine placement" 
        },
        drivetrain: { 
            type: "string", 
            enum: ["FWD", "RWD", "AWD"], 
            description: "Drive configuration" 
        },
        weight: { type: "integer", description: "Curb weight in kilograms" }
    },
    required: ["id", "make", "model", "generation", "year", "hp", "zeroToSixty", "topSpeed", 
               "cylinders", "enginePlacement", "drivetrain", "weight"]
};

// ============================================================================
// UTILITIES
// ============================================================================

const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
    gray: '\x1b[90m'
};

function log(message, type = 'info') {
    const timestamp = new Date().toISOString().substr(11, 8);
    const prefix = {
        info: `${colors.blue}ℹ${colors.reset}`,
        success: `${colors.green}✓${colors.reset}`,
        warning: `${colors.yellow}⚠${colors.reset}`,
        error: `${colors.red}✗${colors.reset}`,
        step: `${colors.cyan}→${colors.reset}`
    };
    console.log(`${colors.gray}[${timestamp}]${colors.reset} ${prefix[type] || prefix.info} ${message}`);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================================
// ANTHROPIC API CLIENT
// ============================================================================

async function callAnthropicAPI(messages, systemPrompt, useTools = false, retryCount = 0) {
    return new Promise((resolve, reject) => {
        const body = {
            model: CONFIG.model,
            max_tokens: CONFIG.maxTokens,
            system: systemPrompt,
            messages: messages
        };

        if (useTools) {
            body.tools = [{
                type: "web_search_20250305",
                name: "web_search"
            }];
        }

        const data = JSON.stringify(body);

        const options = {
            hostname: 'api.anthropic.com',
            port: 443,
            path: '/v1/messages',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': CONFIG.apiKey,
                'anthropic-version': '2023-06-01',
                'Content-Length': Buffer.byteLength(data)
            }
        };

        const req = https.request(options, (res) => {
            let responseData = '';
            
            res.on('data', (chunk) => {
                responseData += chunk;
            });
            
            res.on('end', async () => {
                try {
                    const parsed = JSON.parse(responseData);
                    
                    // Log token usage if available
                    if (parsed.usage) {
                        log(`   Tokens - Input: ${parsed.usage.input_tokens}, Output: ${parsed.usage.output_tokens}`, 'info');
                    }
                    
                    // Handle rate limiting
                    if (res.statusCode === 429 || (parsed.error && parsed.error.type === 'rate_limit_error')) {
                        if (retryCount < CONFIG.retryAttempts) {
                            const waitTime = CONFIG.rateLimitDelay * (retryCount + 1);
                            log(`Rate limited. Waiting ${waitTime / 1000}s before retry...`, 'warning');
                            await sleep(waitTime);
                            resolve(callAnthropicAPI(messages, systemPrompt, useTools, retryCount + 1));
                            return;
                        }
                        reject(new Error('Rate limit exceeded after retries'));
                        return;
                    }
                    
                    if (res.statusCode !== 200) {
                        reject(new Error(parsed.error?.message || `API error: ${res.statusCode}`));
                    } else {
                        resolve(parsed);
                    }
                } catch (e) {
                    reject(new Error(`Failed to parse response: ${e.message}`));
                }
            });
        });

        req.on('error', (e) => {
            reject(new Error(`Request failed: ${e.message}`));
        });

        req.write(data);
        req.end();
    });
}

// ============================================================================
// PIPELINE STAGES
// ============================================================================

/**
 * Stage 1: RAG - Web Search for Car Specifications
 * Uses web search to gather accurate, up-to-date specifications
 */
async function ragSearch(carQuery) {
    log(`RAG: Searching for "${carQuery}" specifications...`, 'step');
    
    const systemPrompt = `You are a car specification research assistant. Use web search to find accurate, verified specifications for cars. 

IMPORTANT: Be concise. Return ONLY the key specifications in a brief summary format:
- Generation/chassis code (e.g., 997.2, Mk7.5, E90 LCI)
- Model years
- Horsepower
- 0-60 mph time  
- Top speed (mph)
- Engine (cylinders, displacement)
- Drivetrain
- Curb weight (kg)

Do NOT include lengthy descriptions, reviews, or marketing text. Just the numbers.`;

    const messages = [{
        role: 'user',
        content: `Find specifications for: ${carQuery}. Return ONLY a brief list of specs (hp, 0-60, top speed, weight, engine, drivetrain, generation code). Be concise.`
    }];

    try {
        const response = await callAnthropicAPI(messages, systemPrompt, true);
        
        let searchResults = '';
        for (const block of response.content) {
            if (block.type === 'text') {
                searchResults += block.text;
            }
        }
        
        // Truncate results to ~2000 chars to keep token usage reasonable
        const maxChars = 2000;
        if (searchResults.length > maxChars) {
            searchResults = searchResults.substring(0, maxChars) + '\n[Results truncated]';
            log(`RAG: Truncated results to ${maxChars} chars`, 'info');
        }
        
        log(`RAG: Found specification data from web search`, 'success');
        return searchResults;
    } catch (error) {
        log(`RAG: Search failed - ${error.message}`, 'warning');
        return null;
    }
}

/**
 * Stage 2: Structured Generation
 * Extracts car data into strict JSON schema format
 */
async function structuredGeneration(carQuery, ragContext, carId) {
    log(`Structured Gen: Extracting JSON for "${carQuery}"...`, 'step');
    
    const systemPrompt = `You are a car specification extraction system. Extract car specifications into precise JSON format.

OUTPUT SCHEMA (follow exactly):
${JSON.stringify(CAR_SCHEMA, null, 2)}

CRITICAL RULES:
1. Output ONLY valid JSON - no markdown, no explanation, no backticks
2. All numeric values must be numbers, not strings
3. Use 0 for cylinders and displacement if electric vehicle
4. Use "N/A" for enginePlacement if electric
5. Weight must be in kilograms (kg) - convert from lbs if necessary
6. Speed must be in mph - convert from km/h if necessary
7. 0-60 time must be in seconds
8. Round decimals appropriately (hp: integer, zeroToSixty: 1 decimal, displacement: 1 decimal)

GENERATION CODES - CRITICAL:
Always identify the correct chassis/generation code INCLUDING FACELIFTS (LCI/facelift variants are distinct):

Porsche 911:
- 996, 996.2 (facelift)
- 997, 997.2 (facelift with new 3.8L DFI engine)
- 991, 991.2 (facelift with turbo engine)
- 992, 992.2 (facelift)

BMW (LCI = Life Cycle Impulse = facelift):
- E46, E46 LCI
- E90/E92, E90/E92 LCI
- F80/F82, F80/F82 LCI
- G80/G82, G80/G82 LCI

VW Golf GTI:
- Mk5, Mk6, Mk7, Mk7.5 (facelift), Mk8, Mk8.5 (facelift)

Mercedes:
- W204, W204 facelift
- W205, W205 facelift

General rule: If the facelift brought mechanical changes (engine, power, weight), treat it as a DISTINCT generation code. Use ".2", "LCI", ".5", or "facelift" suffix as appropriate for the brand.

If you cannot find a specific value, use reasonable estimates based on similar vehicles in the same class.`;

    let userContent = `Extract specifications for: ${carQuery}\nAssign ID: ${carId}\n\nIMPORTANT: Correctly identify the generation/chassis code INCLUDING any facelift designation (.2, LCI, .5, etc.) if applicable.`;
    if (ragContext) {
        userContent += `\n\nResearch data from web search:\n${ragContext}`;
    }

    const messages = [{
        role: 'user',
        content: userContent
    }];

    const response = await callAnthropicAPI(messages, systemPrompt, false);
    
    let jsonText = response.content[0].text;
    
    // Clean up potential markdown formatting
    jsonText = jsonText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    
    try {
        let carData = JSON.parse(jsonText);
        
        // If LLM returned an array, take only the first item
        if (Array.isArray(carData)) {
            log(`Structured Gen: LLM returned array of ${carData.length} cars, using first`, 'warning');
            carData = carData[0];
        }
        
        log(`Structured Gen: Valid JSON extracted`, 'success');
        return carData;
    } catch (e) {
        log(`Structured Gen: JSON parse error, attempting repair...`, 'warning');
        // Attempt to extract JSON object from text (not array)
        const jsonMatch = jsonText.match(/\{[\s\S]*?\}(?=\s*[,\]\n]|$)/);
        if (jsonMatch) {
            return JSON.parse(jsonMatch[0]);
        }
        throw new Error('Failed to extract valid JSON from response');
    }
}

/**
 * Stage 3: Verification Pipeline
 * Cross-references specifications against known data and checks for anomalies
 */
async function verifySpecifications(carData, originalQuery) {
    log(`Verification: Cross-checking specifications...`, 'step');
    
    const systemPrompt = `You are a car specification verification system. Your task is to verify the accuracy of car specifications by cross-referencing with your knowledge and checking for common errors.

Verify each specification and return a JSON object with:
1. "verified": the corrected/verified car data (same schema as input)
2. "confidence": object with confidence scores (0-100) for each field
3. "issues": array of any issues found (empty array if none)
4. "corrections": object listing any fields that were corrected and why

VERIFICATION CHECKS:
- HP should match known specs for this exact model/year/trim
- 0-60 times should be physically plausible (typically 2.5-15 seconds)
- Top speed should correlate with HP and vehicle type
- Weight should be reasonable for vehicle class (typically 2500-6000 lbs)
- Drivetrain should match known configuration
- Engine placement should match vehicle architecture

CORRECTION RULES:
- If a value seems wrong by more than 10%, correct it
- If a value is missing, estimate based on similar vehicles
- Always preserve the original schema format

Output ONLY valid JSON, no markdown or explanation.`;

    const messages = [{
        role: 'user',
        content: `Verify these specifications for ${originalQuery}:
${JSON.stringify(carData, null, 2)}

Check for accuracy and return verified data with confidence scores and any corrections made.`
    }];

    try {
        const response = await callAnthropicAPI(messages, systemPrompt, false);
        let jsonText = response.content[0].text;
        jsonText = jsonText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        
        let verification = JSON.parse(jsonText);
        
        // If LLM returned an array, take only the first item
        if (Array.isArray(verification)) {
            log(`Verification: LLM returned array, using first`, 'warning');
            verification = verification[0];
        }
        
        // Calculate average confidence
        const confidenceValues = Object.values(verification.confidence || {});
        const avgConfidence = confidenceValues.length > 0
            ? confidenceValues.reduce((a, b) => a + b, 0) / confidenceValues.length
            : 0;
        
        // Log results
        if (avgConfidence >= 80) {
            log(`Verification: High confidence (${avgConfidence.toFixed(0)}%)`, 'success');
        } else if (avgConfidence >= 60) {
            log(`Verification: Medium confidence (${avgConfidence.toFixed(0)}%)`, 'warning');
        } else {
            log(`Verification: Low confidence (${avgConfidence.toFixed(0)}%) - consider manual review`, 'error');
        }
        
        // Log any issues
        if (verification.issues && verification.issues.length > 0) {
            verification.issues.forEach(issue => {
                log(`  Issue: ${issue}`, 'warning');
            });
        }
        
        // Log corrections
        if (verification.corrections && Object.keys(verification.corrections).length > 0) {
            Object.entries(verification.corrections).forEach(([field, reason]) => {
                log(`  Corrected ${field}: ${reason}`, 'info');
            });
        }
        
        return {
            data: verification.verified || carData,
            confidence: avgConfidence,
            issues: verification.issues || [],
            corrections: verification.corrections || {}
        };
    } catch (error) {
        log(`Verification: Failed - ${error.message}`, 'warning');
        return {
            data: carData,
            confidence: 50,
            issues: ['Verification failed'],
            corrections: {}
        };
    }
}

/**
 * Stage 4: Schema Validation
 * Validates the final output against the defined schema
 */
function validateSchema(carData) {
    const errors = [];
    
    // Check required fields
    for (const field of CAR_SCHEMA.required) {
        if (carData[field] === undefined || carData[field] === null) {
            errors.push(`Missing required field: ${field}`);
        }
    }
    
    // Type checking
    const typeChecks = [
        ['id', 'number'],
        ['make', 'string'],
        ['model', 'string'],
        ['year', 'number'],
        ['hp', 'number'],
        ['zeroToSixty', 'number'],
        ['topSpeed', 'number'],
        ['cylinders', 'number'],
        ['weight', 'number'],
        ['enginePlacement', 'string'],
        ['drivetrain', 'string']
    ];
    
    for (const [field, expectedType] of typeChecks) {
        if (carData[field] !== undefined && typeof carData[field] !== expectedType) {
            errors.push(`${field} must be a ${expectedType}, got ${typeof carData[field]}`);
        }
    }
    
    // Enum validation
    if (carData.enginePlacement && !['Front', 'Mid', 'Rear', 'N/A'].includes(carData.enginePlacement)) {
        errors.push(`enginePlacement must be Front, Mid, Rear, or N/A (got: ${carData.enginePlacement})`);
    }
    if (carData.drivetrain && !['FWD', 'RWD', 'AWD'].includes(carData.drivetrain)) {
        errors.push(`drivetrain must be FWD, RWD, or AWD (got: ${carData.drivetrain})`);
    }
    
    // Range validation (sanity checks)
    const rangeChecks = [
        ['year', 1900, 2030, 'Model year'],
        ['hp', 0, 3000, 'Horsepower'],
        ['zeroToSixty', 1, 30, '0-60 time'],
        ['topSpeed', 50, 350, 'Top speed'],
        ['weight', 450, 4500, 'Weight'],
        ['cylinders', 0, 16, 'Cylinders']
    ];
    
    for (const [field, min, max, label] of rangeChecks) {
        if (carData[field] !== undefined && (carData[field] < min || carData[field] > max)) {
            errors.push(`${label} (${carData[field]}) seems invalid (expected ${min}-${max})`);
        }
    }
    
    return errors;
}

// ============================================================================
// DEDUPLICATION
// ============================================================================

/**
 * Generates a unique key for a car based on make, model, and generation
 * This ensures we don't store the same car twice
 */
function getCarKey(carData) {
    const make = (carData.make || '').toLowerCase().trim();
    const model = (carData.model || '').toLowerCase().trim();
    const generation = (carData.generation || '').toLowerCase().trim();
    return `${make}|${model}|${generation}`;
}

/**
 * Checks if a car already exists in the results
 * Returns the existing car if found, null otherwise
 */
function findDuplicate(carData, existingCars) {
    const newKey = getCarKey(carData);
    for (const existing of existingCars) {
        if (getCarKey(existing) === newKey) {
            return existing;
        }
    }
    return null;
}

/**
 * Decides which car data to keep when duplicates are found
 * Strategy: Keep the one with the most recent year (latest specs for that gen)
 */
function resolveConflict(existing, newCar) {
    // Keep the newer year's specs (usually more accurate/updated)
    if (newCar.year > existing.year) {
        log(`  Replacing ${existing.year} specs with ${newCar.year} specs (newer)`, 'info');
        return { keep: 'new', reason: 'newer year' };
    } else if (newCar.year < existing.year) {
        log(`  Keeping ${existing.year} specs over ${newCar.year} (newer)`, 'info');
        return { keep: 'existing', reason: 'existing has newer year' };
    } else {
        // Same year - keep existing (first one wins)
        return { keep: 'existing', reason: 'same year, keeping first' };
    }
}

// ============================================================================
// MAIN PIPELINE
// ============================================================================

async function processCar(carQuery, carId) {
    log(`\n${'─'.repeat(60)}`, 'info');
    log(`Processing: ${colors.bright}${carQuery}${colors.reset}`, 'info');
    log('─'.repeat(60), 'info');
    
    let ragContext = null;
    
    // Stage 1: RAG Search
    if (CONFIG.enableRag) {
        ragContext = await ragSearch(carQuery);
    }
    
    // Stage 2: Structured Generation
    let carData = await structuredGeneration(carQuery, ragContext, carId);
    let confidence = 70; // Default confidence
    
    // Stage 3: Verification
    if (CONFIG.enableVerification) {
        const verification = await verifySpecifications(carData, carQuery);
        carData = verification.data;
        confidence = verification.confidence;
    }
    
    // Stage 4: Schema Validation
    if (CONFIG.strictSchemaValidation) {
        const errors = validateSchema(carData);
        if (errors.length > 0) {
            log(`Schema Validation: ${errors.length} issue(s)`, 'warning');
            errors.forEach(err => log(`  - ${err}`, 'warning'));
        } else {
            log(`Schema Validation: Passed`, 'success');
        }
    }
    
    // Ensure ID is set correctly
    carData.id = carId;
    
    return {
        car: carData,
        confidence: confidence
    };
}

async function main() {
    console.log(`
${colors.cyan}╔═══════════════════════════════════════════════════════════╗
║         🚗  Car Data Populator - CLI Tool                 ║
║   Structured Generation + RAG + Verification Pipeline     ║
╚═══════════════════════════════════════════════════════════╝${colors.reset}
`);

    // Validate API key
    if (!CONFIG.apiKey) {
        log('ANTHROPIC_API_KEY not found', 'error');
        console.log(`
${colors.yellow}Setup Instructions:${colors.reset}

1. Create a .env file in the same directory as this script:
   ${colors.cyan}ANTHROPIC_API_KEY=sk-ant-your-key-here${colors.reset}

2. Or set it as an environment variable:
   ${colors.gray}# PowerShell${colors.reset}
   ${colors.cyan}$env:ANTHROPIC_API_KEY="sk-ant-xxx"; node populate-cars.js "Car Name"${colors.reset}
   
   ${colors.gray}# Command Prompt${colors.reset}
   ${colors.cyan}set ANTHROPIC_API_KEY=sk-ant-xxx && node populate-cars.js "Car Name"${colors.reset}
   
   ${colors.gray}# Linux/Mac${colors.reset}
   ${colors.cyan}ANTHROPIC_API_KEY=sk-ant-xxx node populate-cars.js "Car Name"${colors.reset}
`);
        process.exit(1);
    }
    
    if (envLoaded) {
        log('Loaded API key from .env file', 'success');
    }

    // Parse arguments
    const args = process.argv.slice(2);
    let carQueries = [];

    if (args.length === 0) {
        log('No cars specified. Using example cars...', 'warning');
        carQueries = [
            'Porsche 911 GT3 2024',
            'BMW M3 Competition 2024',
            'Tesla Model S Plaid 2024'
        ];
    } else if (args[0] === '--file' && args[1]) {
        // Read from file
        const filePath = args[1];
        if (!fs.existsSync(filePath)) {
            log(`File not found: ${filePath}`, 'error');
            process.exit(1);
        }
        const fileContent = fs.readFileSync(filePath, 'utf-8');
        carQueries = fileContent.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    } else {
        carQueries = args;
    }

    log(`Pipeline Configuration:`, 'info');
    log(`  RAG (Web Search): ${CONFIG.enableRag ? 'Enabled' : 'Disabled'}`, 'info');
    log(`  Verification: ${CONFIG.enableVerification ? 'Enabled' : 'Disabled'}`, 'info');
    log(`  Schema Validation: ${CONFIG.strictSchemaValidation ? 'Strict' : 'Relaxed'}`, 'info');
    log(`  Cars to process: ${carQueries.length}`, 'info');

    const results = [];
    const skippedDuplicates = [];
    let currentId = 1;

    for (const query of carQueries) {
        try {
            const result = await processCar(query, currentId);
            
            // Check for duplicates
            const duplicate = findDuplicate(result.car, results);
            
            if (duplicate) {
                const key = getCarKey(result.car);
                log(`⚠️  Duplicate detected: ${result.car.make} ${result.car.model} (${result.car.generation})`, 'warning');
                
                const resolution = resolveConflict(duplicate, result.car);
                
                if (resolution.keep === 'new') {
                    // Replace existing with new
                    const index = results.findIndex(c => getCarKey(c) === key);
                    result.car.id = duplicate.id; // Keep the original ID
                    results[index] = result.car;
                    skippedDuplicates.push({ query, reason: `Replaced older ${duplicate.year} entry` });
                } else {
                    // Keep existing, skip new
                    skippedDuplicates.push({ query, reason: resolution.reason });
                }
            } else {
                // No duplicate - add to results
                result.car.id = currentId++;
                results.push(result.car);
                log(`Successfully processed: ${result.car.make} ${result.car.model} (${result.car.generation})`, 'success');
            }
        } catch (error) {
            log(`Failed to process "${query}": ${error.message}`, 'error');
            
            // Retry logic
            for (let attempt = 1; attempt <= CONFIG.retryAttempts; attempt++) {
                log(`Retry attempt ${attempt}/${CONFIG.retryAttempts}...`, 'warning');
                await sleep(CONFIG.retryDelay * attempt);
                
                try {
                    const result = await processCar(query, currentId);
                    
                    // Check for duplicates on retry too
                    const duplicate = findDuplicate(result.car, results);
                    if (!duplicate) {
                        result.car.id = currentId++;
                        results.push(result.car);
                        log(`Retry successful: ${result.car.make} ${result.car.model}`, 'success');
                    } else {
                        log(`Retry found duplicate, skipping`, 'warning');
                    }
                    break;
                } catch (retryError) {
                    if (attempt === CONFIG.retryAttempts) {
                        log(`All retries failed for "${query}"`, 'error');
                    }
                }
            }
        }
        
        // Rate limiting delay between cars
        log(`Waiting ${CONFIG.delayBetweenCars / 1000}s before next car...`, 'info');
        await sleep(CONFIG.delayBetweenCars);
    }

    // Output results
    console.log(`\n${colors.cyan}═══════════════════════════════════════════════════════════${colors.reset}`);
    log(`Pipeline complete! Generated ${results.length} unique cars from ${carQueries.length} queries`, 'success');
    
    if (skippedDuplicates.length > 0) {
        log(`Duplicates handled: ${skippedDuplicates.length}`, 'info');
        skippedDuplicates.forEach(d => {
            log(`  - "${d.query}": ${d.reason}`, 'info');
        });
    }

    // Write to data.js
    const dataJsContent = `// Auto-generated by Car Data Populator
// Generated: ${new Date().toISOString()}
// Pipeline: RAG=${CONFIG.enableRag}, Verification=${CONFIG.enableVerification}

const carsDatabase = ${JSON.stringify(results, null, 4)};

export default carsDatabase;
`;

    fs.writeFileSync(CONFIG.outputFile, dataJsContent);
    log(`Written to ${CONFIG.outputFile}`, 'success');

    // Also output JSON for convenience
    fs.writeFileSync('cars-data.json', JSON.stringify(results, null, 2));
    log(`Written to cars-data.json`, 'success');

    // Print summary
    console.log(`\n${colors.bright}Generated Cars:${colors.reset}`);
    results.forEach(car => {
        console.log(`  ${colors.green}✓${colors.reset} ${car.make} ${car.model} ${car.year} - ${car.hp}hp, ${car.zeroToSixty}s 0-60, ${car.topSpeed}mph`);
    });
}

main().catch(error => {
    log(`Fatal error: ${error.message}`, 'error');
    process.exit(1);
});