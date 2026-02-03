const { z } = require("zod");

const userSchema = z.object({
  userId: z.string().min(1, "userId is required"),
  email: z.string().email("Invalid email"),
  name: z.string().min(1, "Name is required"),
  createdAt: z.date().optional(),
  lastLogin: z.date().optional(),
});

// For updating user (only name allowed for now)
const updateUserSchema = z.object({
  name: z.string().min(1, "Name is required"),
});

// For mock login (needs email + name)
const mockLoginSchema = z.object({
  email: z.string().email("Invalid email"),
  name: z.string().min(1, "Name is required"),
});

module.exports = { userSchema, updateUserSchema, mockLoginSchema };
