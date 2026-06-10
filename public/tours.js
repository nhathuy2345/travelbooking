async function loadTours() {

  const container =
    document.getElementById("tour-list");

  try {

    const res =
      await fetch("/api/tours");

    const data =
      await res.json();

    if (!data.success) {
      container.innerHTML =
        "<h3>Không tải được tour</h3>";
      return;
    }

    const tours = data.tours;

    container.innerHTML =
      tours.map(tour => `
        <div class="tour-card">

          <img
            src="${tour.image_url}"
            alt="${tour.title}"
          >

          <div class="tour-title">
            ${tour.title}
          </div>

          <div>
            ${tour.description || ''}
          </div>

          <div class="tour-price">
            ${Number(tour.price).toLocaleString()}đ
          </div>

          <button
            class="btn"
            onclick="window.location.href='booking.html?id=${tour.id}'"
          >
            Đặt Tour
          </button>

        </div>
      `).join("");

  } catch (err) {

    console.error(err);

    container.innerHTML =
      "<h3>Lỗi tải dữ liệu</h3>";
  }
}

loadTours();