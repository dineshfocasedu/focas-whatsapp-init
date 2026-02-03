const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const UserSchema = new Schema({
  userId: { type: String, required: true, unique: true, index: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  name: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  lastLogin: { type: Date },
  
  // Profile fields
  phoneNumber: { type: String, default: null },
  city: { type: String, default: null },
  caLevel: { 
    type: String, 
    enum: ['CA Foundation', 'CA Intermediate', 'CA Final'], 
    default: null 
  },
  examDate: { type: Date, default: null },

  isAdmin: { type: Boolean, default: false },
    
  // Onboarding status tracking
  profileCompleted: { type: Boolean, default: false },
  profileSkipped: { type: Boolean, default: false },
  sessionSkipActive: { type: Boolean, default: false }, 
  lastExamDateUpdate: { type: Date, default: null },
  lastPhoneUpdate: { type: Date, default: null },
  freeTrialUsed: { type: Boolean, default: false },
  
  // --- Fields for OTP Verification ---
  isPhoneVerified: { type: Boolean, default: false },
  phoneOtp: { type: String, default: null },
  phoneOtpExpires: { type: Date, default: null },
  
  // Trial and reminder tracking
  trialStartTime: { type: Date, default: Date.now },
  nextExamDateReminder: { type: Date, default: null },
 /*  subscriptionType: {  // ← ADD THIS
    type: String,
    enum: ['free', 'premium'],
    default: 'free'
  }, */
});

module.exports = mongoose.model('User', UserSchema);