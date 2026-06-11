const tours = {
  1: "Đà Lạt 3N2Đ",
  2: "Phú Quốc 4N3Đ",
  3: "Đà Nẵng - Hội An"
};

const params = new URLSearchParams(window.location.search);
const tourId = params.get("id");

document.getElementById("tour-name").innerText =
  tours[tourId] || "Tour chưa xác định";

document
.getElementById("booking-form")
.addEventListener("submit", async function(e){

  e.preventDefault();

  const bookingData = {
    tourId,
    fullName:
      document.getElementById("fullName").value,

    email:
      document.getElementById("email").value,

    phone:
      document.getElementById("phone").value,

    people:
      document.getElementById("people").value,

    departureDate:
      document.getElementById("departureDate").value,

    note:
      document.getElementById("note").value
  };

  try {

    const response =
      await fetch("/api/bookings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(bookingData)
      });

    const data =
      await response.json();

    if (data.success) {

      document.getElementById("result").innerHTML =
      `
      <h3 style="color:lime">
        Đặt tour thành công
      </h3>
      `;

      document
        .getElementById("booking-form")
        .reset();

    } else {

      document.getElementById("result").innerHTML =
      `
      <h3 style="color:red">
        ${data.message}
      </h3>
      `;
    }

  } catch (err) {

    console.error(err);

    document.getElementById("result").innerHTML =
    `
    <h3 style="color:red">
      Không thể kết nối máy chủ
    </h3>
    `;
  }
});