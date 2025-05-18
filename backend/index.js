require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const bcrypt = require('bcrypt');
const multer = require('multer');
const session = require('express-session');
const flash = require('connect-flash');

const app = express();
const port = 3001;

// Middleware
app.use(cors());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(session({ 
  secret: process.env.SESSION_SECRET || 'your-secret-key', 
  resave: false, 
  saveUninitialized: true,
}));
app.use(flash());

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// File upload configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'public/uploads/');
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({ storage });

// Database connection
let db;
(async () => {
  try {
    db = await mysql.createConnection({
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
    });
    console.log('✅ Veritabanına başarıyla bağlanıldı.');
  } catch (err) {
    console.error('❌ Veritabanı bağlantı hatası:', err);
  }
})();

// Authentication middleware
const isAdmin = (req, res, next) => {
  if (req.session.user && req.session.user.role === 'admin') {
    return next();
  }
  req.flash('error', 'Admin erişimi için yetkiniz yok');
  res.redirect('/login');
};

// Routes
app.get('/', async (req, res) => {
  try {
    const [products] = await db.query('SELECT * FROM products');
    res.render('index', { 
      products,
      user: req.session.user 
    });
  } catch (err) {
    console.error('Sorgu hatası:', err);
    res.status(500).send('Sunucu hatası');
  }
});

app.get('/login', (req, res) => {
  res.render('login', { 
    messages: req.flash(),
    user: req.session.user 
  });
});

app.get('/register', (req, res) => {
  res.render('register', { 
    messages: req.flash(),
    user: req.session.user 
  });
});

app.get('/cart', (req, res) => {
  res.render('cart', { 
    user: req.session.user 
  });
});

// Login işlemi
app.post('/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const [users] = await db.query(
      'SELECT * FROM users WHERE user_email = ?', 
      [email]
    );

    if (users.length === 0) {
      req.flash('error', 'Geçersiz email veya şifre');
      return res.redirect('/login');
    }

    const user = users[0];
    const isMatch = password === user.user_password; // Şimdilik hash yok

    if (!isMatch) {
      req.flash('error', 'Geçersiz email veya şifre');
      return res.redirect('/login');
    }

    req.session.user = {
      id: user.user_id,
      name: user.user_name,
      email: user.user_email,
      role: user.user_role
    };

    res.redirect(user.user_role === 'admin' ? '/admin' : '/');

  } catch (err) {
    console.error('Login hatası:', err);
    req.flash('error', 'Giriş sırasında bir hata oluştu');
    res.redirect('/login');
  }
});

// Logout işlemi
app.get('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      console.error('Logout hatası:', err);
    }
    res.redirect('/login');
  });
});

// Registration
app.post('/register', async (req, res) => {
  const {
    user_name,
    user_surname,
    user_email,
    user_password,
    phone,
    address,
    region_id,
  } = req.body;

  if (!user_name || !user_surname || !user_email || !user_password || !phone || !address || !region_id) {
    req.flash('error', 'Lütfen tüm alanları doldurun.');
    return res.redirect('/register');
  }

  try {
    // Şimdilik hash yok
    const [userResult] = await db.query(
      `INSERT INTO users (user_name, user_surname, user_email, user_password, user_role)
       VALUES (?, ?, ?, ?, 'customer')`,
      [user_name, user_surname, user_email, user_password]
    );

    const user_id = userResult.insertId;

    await db.query(
      `INSERT INTO customers (customer_id, phone, address, region_id)
       VALUES (?, ?, ?, ?)`,
      [user_id, phone, address, region_id]
    );

    req.flash('success', 'Kayıt başarılı! Giriş yapabilirsiniz.');
    res.redirect('/login');
  } catch (err) {
    console.error("Kayıt işlemi hatası:", err);
    req.flash('error', 'Bu email zaten kullanılıyor.');
    res.redirect('/register');
  }
});

// Admin Routes
app.get('/admin', isAdmin, async (req, res) => {
  try {
    const [users] = await db.query(`
      SELECT user_id, user_name, user_surname, user_email, user_role FROM users
    `);

    const [products] = await db.query(`
      SELECT 
        p.product_id, 
        p.product_name, 
        p.product_price, 
        p.product_description, 
        p.product_url,
        c.category_name,
        IFNULL(ps.total_quantity, 100) AS total_quantity
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.category_id
      LEFT JOIN (
        SELECT product_id, SUM(quantity) AS total_quantity
        FROM product_stocks
        GROUP BY product_id
      ) ps ON p.product_id = ps.product_id
    `);

    const [categories] = await db.query('SELECT * FROM categories');

    res.render('admin', { 
      users, 
      products, 
      categories,
      messages: req.flash(),
      user: req.session.user
    });
  } catch (err) {
    console.error('Admin paneli veri çekme hatası:', err);
    res.status(500).send('Admin paneli yüklenirken hata oluştu');
  }
});

// Kullanıcı Silme
app.post('/admin/users/delete', isAdmin, async (req, res) => {
  const { user_id } = req.body;
  
  if (!user_id) {
    req.flash('error', 'Kullanıcı ID gereklidir.');
    return res.redirect('/admin');
  }

  try {
    await db.query('DELETE FROM customers WHERE customer_id = ?', [user_id]);
    await db.query('DELETE FROM users WHERE user_id = ?', [user_id]);
    
    req.flash('success', 'Kullanıcı başarıyla silindi');
    res.redirect('/admin');
  } catch (err) {
    console.error('Kullanıcı silme hatası:', err);
    req.flash('error', 'Kullanıcı silinirken hata oluştu');
    res.redirect('/admin');
  }
});

// Kullanıcı Ekleme
app.post('/admin/users/add', isAdmin, async (req, res) => {
  const { name, surname, email, password, role } = req.body;

  try {
    const query = `
      INSERT INTO users (user_name, user_surname, user_email, user_password, user_role)
      VALUES (?, ?, ?, ?, ?)
    `;

    await db.query(query, [name, surname, email, password, role]);

    res.redirect('/admin');
  } catch (err) {
    console.error('Kullanıcı ekleme hatası:', err);
    req.flash('error', 'Kullanıcı eklenemedi.');
    res.redirect('/admin');
  }
});

// Ürün ekleme
app.post('/admin/products/add', isAdmin, upload.single('image'), async (req, res) => {
  try {
    const { name, category_id, price, description, quantity } = req.body;
    let imageUrl;

    // Eğer dosya yükleme varsa
    if (req.file) {
      imageUrl = '/uploads/' + req.file.filename;
    } else if (req.body.image) {
      // Formdan görsel URL'si gelirse
      imageUrl = req.body.image;
    } else {
      imageUrl = ''; // boş bırakabilir veya varsayılan bir resim atayabilirsin
    }

    // Ürünü ekle
    const [result] = await db.query(
      `INSERT INTO products (product_name, category_id, product_price, product_description, product_url)
       VALUES (?, ?, ?, ?, ?)`,
      [name, category_id, price, description, imageUrl]
    );

    const productId = result.insertId;

    // Stok miktarını product_stocks tablosuna ekle
    const warehouseId = 1; // Varsayılan depo ID'si (sizin veritabanınızdaki uygun ID'yi kullanın)

    await db.query(
      `INSERT INTO product_stocks (product_id, warehouse_id, quantity) VALUES (?, ?, ?)`,
      [productId, warehouseId, quantity]
    );


    req.flash('success', 'Ürün başarıyla eklendi.');
    res.redirect('/admin');
  } catch (err) {
    console.error('Ürün ekleme hatası:', err);
    req.flash('error', 'Ürün eklenirken hata oluştu.');
    res.redirect('/admin');
  }
});

// Ürün silme
app.post('/admin/products/delete', isAdmin, async (req, res) => {
  const { product_id } = req.body;

  if (!product_id) {
    req.flash('error', 'Ürün ID gereklidir.');
    return res.redirect('/admin');
  }

  try {
    // Önce stok tablosundan sil
    await db.query('DELETE FROM product_stocks WHERE product_id = ?', [product_id]);
    // Ardından ürün tablosundan sil
    await db.query('DELETE FROM products WHERE product_id = ?', [product_id]);

    req.flash('success', 'Ürün başarıyla silindi.');
    res.redirect('/admin');
  } catch (err) {
    console.error('Ürün silme hatası:', err);
    req.flash('error', 'Ürün silinirken hata oluştu.');
    res.redirect('/admin');
  }
});


app.post('/add/:id', async (req, res) => {
  const productId = req.params.id;
  const [product] = await db.query('SELECT * FROM products WHERE product_id = ?', [productId]);

  if (!req.session.cart) req.session.cart = [];

  // Sepette varsa miktarı artır
  const existing = req.session.cart.find(p => p.product_id === productId);
  if (existing) {
      existing.quantity += 1;
  } else {
      req.session.cart.push({
          product_id: product[0].product_id,
          product_name: product[0].product_name,
          product_price: product[0].product_price,
          quantity: 1
      });
  }

  res.redirect('/cart');
});


// Server
app.listen(port, () => {
  console.log(`🚀 Sunucu http://localhost:${port} adresinde çalışıyor.`);
});

