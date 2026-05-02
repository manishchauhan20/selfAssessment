const express = require('express');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const Book = require('../models/Book');
const { getValidChapters, getValidTopics, validateParsedPDFData } = require('../utils/pdfArchitecture');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'mySecretKey';

function getAuthUserFromRequest(req) {
  const authHeader = req.headers?.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) return null;

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    return {
      id: String(decoded?.id || ''),
      role: String(decoded?.role || ''),
    };
  } catch {
    return null;
  }
}

function requireAuth(req, res, next) {
  const authUser = getAuthUserFromRequest(req);
  if (!authUser?.id || !mongoose.Types.ObjectId.isValid(authUser.id)) {
    return res.status(401).json({ error: 'Unauthorized. Please login again.' });
  }
  req.authUser = authUser;
  return next();
}

router.get('/catalog', requireAuth, async (req, res) => {
  try {
    const classNameFilter = String(req.query.className || '').trim();
    const subjectFilter = String(req.query.subject || '').trim();

    const rawBooks = await Book.find({})
      .sort({ className: 1, subject: 1, title: 1, createdAt: -1 })
      .select('title className subject parsedData chapterCount topicCount questionCount createdAt')
      .lean();

    const booksWithStructure = rawBooks.map((book) => {
      const validatedData = validateParsedPDFData(book?.parsedData || {});
      const chapters = getValidChapters(validatedData).map((chapterName) => ({
        name: chapterName,
        topics: getValidTopics(validatedData, chapterName),
      }));

      return {
        id: String(book._id),
        title: String(book.title || ''),
        className: String(book.className || ''),
        subject: String(book.subject || ''),
        chapterCount: Number(book.chapterCount || chapters.length || 0),
        topicCount: Number(
          book.topicCount || chapters.reduce((count, chapter) => count + chapter.topics.length, 0)
        ),
        questionCount: Number(book.questionCount || 0),
        createdAt: book.createdAt,
        chapters,
      };
    });

    const classes = Array.from(new Set(booksWithStructure.map((book) => book.className).filter(Boolean))).sort(
      (a, b) => Number(a) - Number(b)
    );

    const subjects = Array.from(
      new Set(
        booksWithStructure
          .filter((book) => (classNameFilter ? book.className === classNameFilter : true))
          .map((book) => book.subject)
          .filter(Boolean)
      )
    ).sort((a, b) => a.localeCompare(b));

    const filteredBooks = booksWithStructure.filter((book) => {
      if (classNameFilter && book.className !== classNameFilter) return false;
      if (subjectFilter && book.subject !== subjectFilter) return false;
      return true;
    });

    return res.json({
      classes,
      subjects,
      books: filteredBooks,
    });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to fetch book catalog.', message: error?.message || error });
  }
});

module.exports = router;
