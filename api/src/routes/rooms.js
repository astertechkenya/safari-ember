// rooms.js: GET /api/rooms, the room types for the site's rooms section.
import { Router } from 'express';
import { listRooms } from '../services/bookings.js';

export const roomsRouter = Router();

roomsRouter.get('/', async (req, res) => {
  // Prices change rarely; a minute of caching spares the database on every page view.
  res.set('Cache-Control', 'public, max-age=60');
  res.json({ rooms: await listRooms() });
});
