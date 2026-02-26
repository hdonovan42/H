// Mock API server for frontend preview
import express from 'express'

const app = express()
app.use(express.json())

const MOCK_USER = { userId: 1, email: 'test@autosnipe.co.uk', phone: null, paid_slots: 0 }

const MOCK_SEARCHES = [
  {
    id: 1,
    user_id: 1,
    name: 'Volkswagen Golf GTI Performance',
    criteria: JSON.stringify({ make: 'Volkswagen', model: 'Golf', variant: 'GTI Performance', year_from: 2017, year_to: 2019, mileage_max: 60000, transmission: 'Manual' }),
    active: 1,
    last_checked: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19),
    last_result_count: 20,
    total_listings: 20,
    notified_count: 5,
    created_at: '2026-02-25 22:33:26'
  },
  {
    id: 2,
    user_id: 1,
    name: 'BMW M3',
    criteria: JSON.stringify({ make: 'BMW', model: 'M3', year_from: 2015, year_to: 2020, price_from: 20000, price_to: 40000, fuel_type: 'Petrol', postcode: 'M1 1AA', radius: 100 }),
    active: 1,
    last_checked: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19),
    last_result_count: 8,
    total_listings: 8,
    notified_count: 3,
    created_at: '2026-02-26 01:00:00'
  }
]

const MOCK_LISTINGS = {
  1: [
    { id: 1, title: 'Volkswagen Golf 2.0 TSI GTI Performance Euro 6 (s/s) 5dr', price: 18450, year: 2019, mileage: 48001, fuel_type: 'Petrol', transmission: 'Manual', seller_type: 'Trade', location: 'Derby', url: 'https://www.autotrader.co.uk/car-details/202602240185629', image_url: 'https://m.atcdn.co.uk/a/media/800x600/3fc4dfd6b56d4fdfb9e8b5ebd73c01c4.jpg', first_seen: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString() },
    { id: 2, title: 'Volkswagen Golf 2.0 TSI GTI Performance Euro 6 (s/s) 5dr', price: 16999, year: 2018, mileage: 48450, fuel_type: 'Petrol', transmission: 'Manual', seller_type: 'Trade', location: 'Cambridge', url: 'https://www.autotrader.co.uk/car-details/202602180033710', image_url: 'https://m.atcdn.co.uk/a/media/800x600/14898e1804984dc8b56e3a39e51e6b87.jpg', first_seen: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString() },
    { id: 3, title: 'Volkswagen Golf 2.0 TSI GTI Performance Euro 6 (s/s) 3dr', price: 17399, year: 2018, mileage: 50109, fuel_type: 'Petrol', transmission: 'Manual', seller_type: 'Private', location: 'Nottingham', url: 'https://www.autotrader.co.uk/car-details/202602169963334', image_url: 'https://m.atcdn.co.uk/a/media/800x600/dd38980f63194f79a57e25e52b072562.jpg', first_seen: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString() },
    { id: 4, title: 'Volkswagen Golf 2.0 TSI GTI Performance Euro 6 (s/s) 5dr', price: 19989, year: 2018, mileage: 34500, fuel_type: 'Petrol', transmission: 'Manual', seller_type: 'Trade', location: 'Leamington Spa', url: 'https://www.autotrader.co.uk/car-details/202602139919886', image_url: 'https://m.atcdn.co.uk/a/media/800x600/522cfd2370374bb1a39d089e39c4016f.jpg', first_seen: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString() },
    { id: 5, title: 'Volkswagen Golf 2.0 TSI GTI Performance Euro 6 (s/s) 5dr', price: 17386, year: 2019, mileage: 57616, fuel_type: 'Petrol', transmission: 'Manual', seller_type: 'Private', location: 'Rainham', url: 'https://www.autotrader.co.uk/car-details/202602129872925', image_url: 'https://m.atcdn.co.uk/a/media/800x600/b487ea5b963f4936a132bc2288c3dfbc.jpg', first_seen: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() },
    { id: 6, title: 'Volkswagen Golf 2.0 TSI GTI Performance DSG Euro 6 (s/s) 5dr', price: 15750, year: 2017, mileage: 58200, fuel_type: 'Petrol', transmission: 'Automatic', seller_type: 'Trade', location: 'Bristol', url: 'https://www.autotrader.co.uk/car-details/202602100000001', image_url: 'https://m.atcdn.co.uk/a/media/800x600/b23b2557c78841438c441e31568ab6f0.jpg', first_seen: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString() },
  ],
  2: [
    { id: 10, title: 'BMW M3 3.0 BiTurbo Competition DCT Euro 6 (s/s) 4dr', price: 38995, year: 2019, mileage: 31000, fuel_type: 'Petrol', transmission: 'Automatic', seller_type: 'Trade', location: 'Manchester', url: 'https://www.autotrader.co.uk/car-details/202602100000010', image_url: 'https://m.atcdn.co.uk/a/media/800x600/9406fd81ca5343749c59ec21b4b8ae10.jpg', first_seen: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() },
    { id: 11, title: 'BMW M3 3.0 M DCT Euro 6 (s/s) 4dr', price: 29500, year: 2016, mileage: 52000, fuel_type: 'Petrol', transmission: 'Automatic', seller_type: 'Private', location: 'Leeds', url: 'https://www.autotrader.co.uk/car-details/202602100000011', image_url: 'https://m.atcdn.co.uk/a/media/800x600/fef9dc04b1c44052a4a384ef904a191a.jpg', first_seen: new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString() },
    { id: 12, title: 'BMW M3 3.0 BiTurbo Competition Pack DCT Euro 6 4dr', price: 35750, year: 2018, mileage: 42000, fuel_type: 'Petrol', transmission: 'Automatic', seller_type: 'Trade', location: 'Sheffield', url: 'https://www.autotrader.co.uk/car-details/202602100000012', image_url: 'https://m.atcdn.co.uk/a/media/800x600/d8c9b9532fac469887a57e4b25421f94.jpg', first_seen: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() },
  ]
}

// Skip auth for mock
app.get('/api/auth/me', (req, res) => res.json(MOCK_USER))
app.get('/api/searches', (req, res) => res.json(MOCK_SEARCHES))
app.get('/api/searches/:id/listings', (req, res) => {
  res.json(MOCK_LISTINGS[req.params.id] || [])
})
app.get('/api/matches/recent', (req, res) => res.json([]))
app.get('/api/taxonomy', (req, res) => res.json({ makes: {} }))
app.get('/api/health', (req, res) => res.json({ ok: true }))

app.listen(3103, () => console.log('Mock API on :3103'))
