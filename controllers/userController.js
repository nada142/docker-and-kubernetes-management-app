const User = require('../models/User');
const session = require('express-session');
const store =new session.MemoryStore();
const MongoStore = require('connect-mongo');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const express = require('express');

const bcrypt = require('bcrypt');  


exports.createUser = async (req, res) => {
    try {
        const { username, email, password } = req.body;
        const hashedPassword = await bcrypt.hash(password, 10);
        // Validate input
        if (!username || !email || !password) {
            return res.status(400).json({ error: 'All fields are required' });
        }

        // Create and save user
        const user = new User({ username, email, password: hashedPassword });
        await user.save();

        res.status(201).json(user);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

exports.getAllUsers = async (req, res) => {
  try {
    const users = await User.find();
    res.status(200).json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.loginUser = async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await User.findOne({ email });
    
    if (user && await bcrypt.compare(password, user.password)) {
      req.session.authenticated = true;
      req.session.user = { 
        _id: user._id, 
        email: user.email,
        username: user.username
      };
      
      res.json({
        success: true,
        user: {
          _id: user._id,
          username: user.username,
          email: user.email
        }
      });
    } else {
      res.status(403).json({ 
        success: false,
        error: 'Invalid email or password' 
      });
    }
  } catch (err) {
    res.status(500).json({ 
      success: false,
      error: 'Server error during login' 
    });
  }
};


// user logout
exports.logoutUser = (req, res) => {
  req.session.destroy(err => {
    if (err) {
      return res.status(500).json({ error: 'Failed to log out' });
    }
    res.clearCookie('connect.sid');
    res.status(200).json({ message: 'Logged out successfully' });
  });
};


exports.getUserActivityData = async (req, res) => {
  try {
    const users = await User.find({});
    const data = users.map(user => ({
      username: user.username,
      lastActive: user.lastActive
    }));
    res.json(data);
  } catch (err) {
    res.status(500).send(err);
  }
};


exports.getUserById = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.status(200).json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.updateUser = async (req, res) => {
  try {
    const { username, email, password } = req.body;
    const updateData = { username, email };

    if (password) {
      updateData.password = await bcrypt.hash(password, 10);
    }

    const user = await User.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: true }
    );

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (req.session.user._id === user._id.toString()) {
      req.session.user.username = user.username;
      req.session.user.email = user.email;
    }

    res.status(200).json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};


exports.deleteUser = async (req, res) => {
  try {
    const user = await User.findByIdAndDelete(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.status(200).json({ message: 'User deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
