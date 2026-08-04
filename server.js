const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Razorpay = require("razorpay");
const multer = require("multer");
const { v2: cloudinary } = require("cloudinary");

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

const PF = path.join(__dirname, "products.json");
const OF = path.join(__dirname, "orders.json");

const read = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return [];
  }
};

const write = (file, data) => {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
};

/* =========================
   CLOUDINARY
========================= */

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024
  }
});

function uploadToCloudinary(buffer) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: "vetbeings/products",
        resource_type: "image"
      },
      (error, result) => {
        if (error) reject(error);
        else resolve(result);
      }
    );

    stream.end(buffer);
  });
}

/* =========================
   ADMIN SECURITY
========================= */

const adminAuth = (req, res, next) => {
  if (!process.env.ADMIN_PASSWORD) {
    return res.status(503).json({
      error: "ADMIN_PASSWORD not configured"
    });
  }

  if (
    req.headers.authorization !==
    "Bearer " + process.env.ADMIN_PASSWORD
  ) {
    return res.status(401).json({
      error: "Unauthorized"
    });
  }

  next();
};

/* =========================
   PRODUCTS
========================= */

app.get("/api/products", (req, res) => {
  res.json(read(PF));
});

/* ADD / EDIT PRODUCT */

app.post(
  "/api/admin/products",
  adminAuth,
  upload.single("image"),
  async (req, res) => {
    try {
      let products = read(PF);

      let product = {
        id: req.body.id
          ? Number(req.body.id)
          : Date.now(),

        name: req.body.name || "",
        category: req.body.category || "",
        price: Number(req.body.price || 0),
        stock: Number(req.body.stock || 0)
      };

      /* IMAGE UPLOAD */

      if (req.file) {
        const result = await uploadToCloudinary(
          req.file.buffer
        );

        product.image = result.secure_url;
        product.imagePublicId = result.public_id;
      }

      const index = products.findIndex(
        (x) => x.id == product.id
      );

      if (index >= 0) {
        /* Keep old image if new image not uploaded */

        if (!product.image && products[index].image) {
          product.image = products[index].image;
          product.imagePublicId =
            products[index].imagePublicId;
        }

        products[index] = {
          ...products[index],
          ...product
        };
      } else {
        products.push(product);
      }

      write(PF, products);

      res.json({
        ok: true,
        product
      });

    } catch (e) {
      console.error(e);

      res.status(500).json({
        error: e.message
      });
    }
  }
);

/* DELETE PRODUCT */

app.delete(
  "/api/admin/products/:id",
  adminAuth,
  async (req, res) => {
    try {
      let products = read(PF);

      const product = products.find(
        (x) => x.id == req.params.id
      );

      if (
        product &&
        product.imagePublicId
      ) {
        try {
          await cloudinary.uploader.destroy(
            product.imagePublicId
          );
        } catch (e) {
          console.error(
            "Cloudinary delete error:",
            e.message
          );
        }
      }

      products = products.filter(
        (x) => x.id != req.params.id
      );

      write(PF, products);

      res.json({
        ok: true
      });

    } catch (e) {
      res.status(500).json({
        error: e.message
      });
    }
  }
);

/* =========================
   ORDERS
========================= */

app.get(
  "/api/admin/orders",
  adminAuth,
  (req, res) => {
    res.json(read(OF));
  }
);

app.post("/api/orders", (req, res) => {
  const orders = read(OF);

  const order = {
    id: "VB" + Date.now(),
    time: new Date().toISOString(),
    status: "pending",
    payment: "COD",
    ...req.body
  };

  orders.unshift(order);

  write(OF, orders);

  res.json(order);
});

/* =========================
   RAZORPAY
========================= */

app.post(
  "/api/payment/order",
  async (req, res) => {
    try {

      if (
        !process.env.RAZORPAY_KEY_ID ||
        !process.env.RAZORPAY_KEY_SECRET
      ) {
        return res.status(503).json({
          error:
            "Razorpay keys not configured."
        });
      }

      const razorpay = new Razorpay({
        key_id:
          process.env.RAZORPAY_KEY_ID,

        key_secret:
          process.env.RAZORPAY_KEY_SECRET
      });

      const order =
        await razorpay.orders.create({
          amount: Math.round(
            Number(req.body.amount) * 100
          ),

          currency: "INR",

          receipt:
            "vb_" + Date.now()
        });

      res.json({
        order,
        key:
          process.env.RAZORPAY_KEY_ID
      });

    } catch (e) {

      console.error(e);

      res.status(500).json({
        error: e.message
      });
    }
  }
);

/* VERIFY PAYMENT */

app.post(
  "/api/payment/verify",
  (req, res) => {

    try {

      const {
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature,
        customer,
        items,
        total
      } = req.body;

      if (
        !process.env
          .RAZORPAY_KEY_SECRET
      ) {
        return res.status(503).json({
          error:
            "Razorpay secret not configured."
        });
      }

      const expected = crypto
        .createHmac(
          "sha256",
          process.env
            .RAZORPAY_KEY_SECRET
        )
        .update(
          razorpay_order_id +
          "|" +
          razorpay_payment_id
        )
        .digest("hex");

      if (expected !== razorpay_signature) {
        return res.status(400).json({
          error:
            "Invalid payment signature"
        });
      }

      const orders = read(OF);

      const order = {
        id: "VB" + Date.now(),
        time:
          new Date().toISOString(),
        status: "paid",
        payment: "Razorpay",
        paymentId:
          razorpay_payment_id,
        customer,
        items,
        total
      };

      orders.unshift(order);

      write(OF, orders);

      res.json({
        ok: true,
        order
      });

    } catch (e) {

      res.status(500).json({
        error: e.message
      });
    }
  }
);

/* =========================
   SERVER
========================= */

const PORT =
  process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(
    "VetBeings running on port " +
    PORT
  );
});
