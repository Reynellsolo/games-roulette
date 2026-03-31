const mongoose = require('mongoose');

const gameLinkSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, index: true },
  tier: { type: String, enum: ['starter', 'bronze', 'silver', 'gold', 'diamond'], required: true },
  active: { type: Boolean, default: true },

  // Данные покупателя
  spinCompleted: { type: Boolean, default: false },
  excludeDuplicates: { type: Boolean, default: false },
  steamProfileUrl: { type: String, default: null },
  steamId: { type: String, default: null },
  steamName: { type: String, default: null },
  steamAvatar: { type: String, default: null },
  country: { type: String, default: null },

  // Доплата ДО рулетки (повышенный шанс)
  boosted: { type: Boolean, default: false },
  boostPaid: { type: Boolean, default: false },
  boostOrderId: { type: String, default: null },
  boostTransactionId: { type: String, default: null },

  // Доплата ПОСЛЕ (перекрутка)
  respinRequested: { type: Boolean, default: false },
  respinType: { type: String, enum: ['normal', 'premium', null], default: null },
  respinPaid: { type: Boolean, default: false },
  respinOrderId: { type: String, default: null },
  respinTransactionId: { type: String, default: null },
  respinCount: { type: Number, default: 0 },

  // Ключ
  keyAssigned: { type: Boolean, default: false },
  keyRevealed: { type: Boolean, default: false },
  gameName: { type: String, default: null },
  gameKey: { type: String, default: null },
  steamAppId: { type: String, default: null },

  note: { type: String, default: '' }
}, { timestamps: true });

module.exports = mongoose.model('GameLink', gameLinkSchema);
